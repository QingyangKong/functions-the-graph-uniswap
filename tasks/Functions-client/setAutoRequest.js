const { buildRequestCBOR, SecretsManager, SubscriptionManager, Location } = require("@chainlink/functions-toolkit")

const { types } = require("hardhat/config")
const { networks } = require("../../networks")
const { getRequestConfig } = require("../../FunctionsSandboxLibrary")
const path = require("path")
const process = require("process")

task(
  "functions-set-auto-request",
  "sets the CBOR-encoded Functions request in a deployed AutomatedFunctionsConsumer contract"
)
  .addParam("contract", "Address of the client contract")
  .addParam("subid", "Billing subscription ID used to pay for Functions requests", undefined, types.int)
  .addParam(
    "slotid",
    "Storage slot number 0 or higher. If the slotid is already in use, the existing secrets for that slotid will be overwritten."
  )
  .addOptionalParam("interval", "Update interval in seconds for Automation to call performUpkeep", 300, types.int)
  .addOptionalParam(
    "ttl",
    "time to live - minutes until the secrets hosted on the DON expire. Defaults to 120m, and must be minimum 5m",
    120,
    types.int
  )
  .addOptionalParam(
    "gaslimit",
    "Maximum amount of gas that can be used to call fulfillRequest in the client contract",
    250000,
    types.int
  )
  .addOptionalParam(
    "simulate",
    "Flag indicating if simulation should be run before making an on-chain request",
    true,
    types.boolean
  )
  .addOptionalParam(
    "configpath",
    "Path to Functions request config file",
    `${__dirname}/../../Functions-request-config.js`,
    types.string
  )
  .setAction(async (taskArgs) => {
    if (network.name === "hardhat") {
      throw Error(
        'This command cannot be used on a local hardhat chain.  Specify a valid network or simulate an FunctionsConsumer request locally with "npx hardhat functions-simulate".'
      )
    }

    await setAutoRequest(taskArgs.contract, taskArgs)
  })

const setAutoRequest = async (contract, taskArgs) => {
  const subscriptionId = taskArgs.subid
  const callbackGasLimit = taskArgs.gaslimit

  const functionsRouterAddress = networks[network.name]["functionsRouter"]
  const donId = networks[network.name]["donId"]
  const signer = await ethers.getSigner()
  const linkTokenAddress = networks[network.name]["linkToken"]

  // Initialize SubscriptionManager
  const subManager = new SubscriptionManager({ signer, linkTokenAddress, functionsRouterAddress })
  await subManager.initialize()

  // Validate callbackGasLimit
  const { gasPrice } = await hre.ethers.provider.getFeeData()
  const gasPriceGwei = BigInt(Math.ceil(hre.ethers.utils.formatUnits(gasPrice, "gwei").toString()))
  _ = await subManager.estimateFunctionsRequestCost({
    donId,
    subscriptionId,
    callbackGasLimit,
    gasPriceGwei,
  })

  // Check that consumer contract is added to subscription.
  const subInfo = await subManager.getSubscriptionInfo(subscriptionId)
  if (!subInfo.consumers.map((c) => c.toLowerCase()).includes(taskArgs.contract.toLowerCase())) {
    throw Error(`Consumer contract ${taskArgs.contract} has not been added to subscription ${subscriptionId}`)
  }

  console.log(`\nSetting the Functions request in AutomatedFunctionsConsumer contract ${contract} on ${network.name}`)
  const autoClientContractFactory = await ethers.getContractFactory("AutomatedFunctionsConsumer")
  const autoClientContract = await autoClientContractFactory.attach(contract)

  const unvalidatedRequestConfig = require(path.isAbsolute(taskArgs.configpath)
    ? taskArgs.configpath
    : path.join(process.cwd(), taskArgs.configpath))

  const requestConfig = getRequestConfig(unvalidatedRequestConfig)

  if (!requestConfig.secrets || Object.keys(requestConfig.secrets).length === 0) {
    throw Error("\nThis task requires a secrets object in request config. None found")
  }

  if (requestConfig.secretsLocation !== Location.DONHosted) {
    throw Error(
      `\nThis task supports only DON-hosted secrets. The request config specifies ${
        Location[requestConfig.secretsLocation]
      }.`
    )
  }

  let encryptedSecretsReference
  if (requestConfig.secrets && Object.keys(requestConfig.secrets).length > 0) {
    console.log("\nEncrypting secrets and uploading to DON...")
    const secretsManager = new SecretsManager({
      signer,
      functionsRouterAddress,
      donId,
    })

    await secretsManager.initialize()
    const encryptedSecretsObj = await secretsManager.encryptSecrets(requestConfig.secrets)
    const slotId = parseInt(taskArgs.slotid)
    const minutesUntilExpiration = taskArgs.ttl

    const { version, success } = await secretsManager.uploadEncryptedSecretsToDON({
      encryptedSecretsHexstring: encryptedSecretsObj.encryptedSecrets,
      gatewayUrls: networks[network.name]["gatewayUrls"],
      storageSlotId: slotId,
      minutesUntilExpiration,
    })

    if (!success) {
      throw Error("\nFailed to upload encrypted secrets to DON.")
    }

    console.log(`\nNow using DON-hosted secrets version ${version} in slot ${slotId}...`)
    encryptedSecretsReference = await secretsManager.buildDONHostedEncryptedSecretsReference({
      slotId,
      version,
    })
  }

  const functionsRequestCBOR = buildRequestCBOR({
    codeLocation: requestConfig.codeLocation,
    codeLanguage: requestConfig.codeLanguage,
    source: requestConfig.source,
    args: requestConfig.args,
    secretsLocation: requestConfig.secretsLocation,
    encryptedSecretsReference,
  })

  console.log("\nSetting Functions request...")
  const setRequestTx = await autoClientContract.setRequest(
    taskArgs.subid,
    taskArgs.gaslimit,
    taskArgs.interval,
    functionsRequestCBOR
  )

  console.log(
    `\nWaiting ${networks[network.name].confirmations} block for transaction ${setRequestTx.hash} to be confirmed...`
  )
  await setRequestTx.wait(networks[network.name].confirmations)
  console.log("\nSet request Tx confirmed")
}

exports.setAutoRequest = setAutoRequest
