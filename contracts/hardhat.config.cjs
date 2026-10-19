/** Local chain + compiler config. The default Hardhat mnemonic is test-only. */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      mining: { auto: true },
      accounts: { count: 12 },
    },
  },
};
