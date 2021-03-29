/*
Run with
```
node index.js 2>&1 | tee -a $HOME/cron.log
```
*/

const Sequelize = require("sequelize");
const SmartChain = require("node-komodo-rpc");
const axios = require("axios");
const moment = require("moment");
let authsAws = require("./creds.js");

const pubkeyToAddress = require("./pubkeyToAddress.js").pubkeyToAddress;

const delaySec = (s) => new Promise((res) => setTimeout(res, s * 1000));

const saveToAwsS3 = async (bucket, fileName, fileData) => {
  const AWS = require("aws-sdk");
  // the bucket already exists

  const apiVersion = "2006-03-01";
  const { accessKeyId, secretAccessKey } = authsAws;
  AWS.config.update({
    region: "us-east-2",
  });

  const s3 = new AWS.S3({
    apiVersion,
    accessKeyId,
    secretAccessKey,
  });

  const uploadParams = {
    Bucket: bucket,
    Key: fileName,
    Body: fileData,
    ACL: "public-read",
    ContentType: "json",
  };

  try {
    let fileLocation = await s3.upload(uploadParams).promise();
    console.log("Upload Success fileLocation:", fileLocation.Location);
  } catch (err) {
    console.log("Error", err);
  }
};

const sequelize = new Sequelize("database", "user", "password", {
  host: "localhost",
  dialect: "sqlite",
  logging: false,
  // SQLite only
  storage: "db.sqlite",
});

const Transactions = sequelize.define("transactions", {
  txid: {
    type: Sequelize.STRING,
    unique: true,
    primaryKey: true,
  },
  txData: Sequelize.TEXT,
  chain: Sequelize.STRING,
  notaries: {
    type: Sequelize.TEXT,
    defaultValue: "",
  },
  height: Sequelize.INTEGER,
  unixTimestamp: Sequelize.INTEGER,
});

const NotariesList = sequelize.define("notariesList", {
  pubkey: {
    type: Sequelize.STRING,
    unique: true,
    primaryKey: true,
  },
  name: Sequelize.STRING,
  address: Sequelize.STRING,
  RICK: {
    type: Sequelize.INTEGER,
    defaultValue: "0",
  },
  lastRICKNotaTxnIdStamp: {
    type: Sequelize.STRING,
    defaultValue: "",
  },
  MORTY: {
    type: Sequelize.INTEGER,
    defaultValue: "0",
  },
  lastMORTYNotaTxnIdStamp: {
    type: Sequelize.STRING,
    defaultValue: "",
  },
  // TXSCLAPOW: {
  //     type: Sequelize.INTEGER,
  //     defaultValue: '0'
  // },
  // lastTXSCLAPOWNotaTxnIdStamp: {
  //     type: Sequelize.STRING,
  //     defaultValue: ''
  // },
  KMD: {
    type: Sequelize.INTEGER,
    defaultValue: "0",
  },
});

const State = sequelize.define("state", {
  name: {
    type: Sequelize.STRING, // lastBlock, totalNotarizations,
    unique: true,
  },
  RICK: Sequelize.INTEGER,
  MORTY: Sequelize.INTEGER,
  //  TXSCLAPOW: Sequelize.INTEGER,
  KMD: Sequelize.INTEGER,
});

const isNotarizationTxn = async (transactionData) => {
  const transactionDataObj =
    typeof transactionData === "object" && transactionData !== null
      ? transactionData
      : JSON.parse(transactionData);

  const isCorrectNumVins =
    1 < transactionDataObj.vin.length && transactionDataObj.vin.length < 15;
  let isAllVinsNotaries = true;

  for (const utxo of transactionDataObj.vin) {
    const isNotary = await NotariesList.findOne({
      where: {
        address: utxo.address,
      },
    });
    isAllVinsNotaries = isAllVinsNotaries && isNotary;
  }
  if (isCorrectNumVins && isAllVinsNotaries) {
    return true;
  } else {
    return false;
  }
};

const addTxnToDb = async (transactionData, chainName) => {
  const transactionDataObj =
    typeof transactionData === "object" && transactionData !== null
      ? transactionData
      : JSON.parse(transactionData);
  const transactionDataStr =
    typeof transactionData === "object" && transactionData !== null
      ? JSON.stringify(transactionData)
      : transactionData;

  const notaryString = transactionDataObj.vin
    .map((utxo) => utxo.address)
    .toString();

  try {
    const transaction = await Transactions.create({
      txid: transactionDataObj.txid,
      txData: transactionDataStr,
      chain: chainName,
      notaries: notaryString,
      height: transactionDataObj.height,
      unixTimestamp: transactionDataObj.time,
    });
    console.log(
      `transaction: "${transaction.txid}" of ${chainName} added to transactions db.`
    );
    const notariesArray = transaction.get("notaries").split(",");

    for (const addr of notariesArray) {
      try {
        const notary = await NotariesList.findOne({
          where: {
            address: addr,
          },
        });
        await notary.increment(chainName);
        if (notary[`last${chainName}NotaTxnIdStamp`]) {
          const oldNotaTxn = await Transactions.findOne({
            where: {
              txid: notary[`last${chainName}NotaTxnIdStamp`].split(",")[0],
            },
          });

          if (
            parseInt(oldNotaTxn.unixTimestamp) <
            parseInt(transaction.unixTimestamp)
          ) {
            notary[`last${chainName}NotaTxnIdStamp`] =
              transaction.txid + "," + transaction.unixTimestamp;
            await notary.save();
          }
        } else {
          notary[`last${chainName}NotaTxnIdStamp`] =
            transaction.txid + "," + transaction.unixTimestamp;
          await notary.save();
        }
      } catch (error) {
        console.log(
          `Something went wrong when incrementing Notarization count of "${addr}" \n` +
            error
        );
      }
    }

    const totalNotarizations = await State.findOne({
      where: {
        name: "totalNotarizations",
      },
    });
    await totalNotarizations.increment(chainName);
  } catch (e) {
    if (e.name === "SequelizeUniqueConstraintError") {
      console.log(
        `transaction: "${transactionDataObj.txid}" of ${chainName} chain already exists in the transactions db.`
      );
    } else {
      console.log(
        `Something went wrong when dealing with transaction: "${transactionDataObj.txid}"  \n` +
          e
      );
    }
  }
};

const processSmartChain = async (name, start) => {
  try {
    const chain = new SmartChain({
      name: name,
    });
    const lastBlock = await State.findOne({
      where: {
        name: "lastBlock",
      },
    });

    const rpc = chain.rpc();
    const getInfo = await rpc.getinfo();
    const currBlockheight = getInfo.blocks;
    let txnIds;
    if (lastBlock[name] == 0) {
      txnIds = await rpc.getaddresstxids({
        addresses: ["RXL3YXG2ceaB6C5hfJcN4fvmLH2C34knhA"],
        start: start,
        end: currBlockheight,
      });
    } else if (lastBlock[name] <= currBlockheight) {
      txnIds = await rpc.getaddresstxids({
        addresses: ["RXL3YXG2ceaB6C5hfJcN4fvmLH2C34knhA"],
        start: lastBlock[name],
        end: currBlockheight,
      });
    } else {
      throw "Error: past processed blockheight greater than current";
    }

    for (const txnId of txnIds) {
      const txn = await rpc.getrawtransaction(txnId, 1);
      // await delaySec(0.05);
      if (await isNotarizationTxn(txn)) {
        await addTxnToDb(txn, name);
      }
    }

    lastBlock[name] = currBlockheight;
    await lastBlock.save();
  } catch (error) {
    console.log(`Something went wrong.Error: \n` + error);
  }
};
(async () => {
  let loopCount = 0;
  while (true) {
    await Transactions.sync();
    await NotariesList.sync();
    await State.sync();

    try {
      const response = await axios.get(
        "https://raw.githubusercontent.com/KomodoPlatform/dPoW/2021-testnet/iguana/testnet.json"
      );
      const testnetJson =
        typeof response.data === "object" && response.data !== null
          ? response.data
          : JSON.parse(response.data);

      for (const notary of testnetJson.notaries) {
        let notaryName = Object.keys(notary)[0];
        let pubkey = notary[notaryName];
        let address = pubkeyToAddress(pubkey);
        try {
          const notary = await NotariesList.create({
            pubkey: pubkey,
            name: notaryName,
            address: address,
          });
          console.log(
            `notary ${notary.name} (${notary.address})  added to the DB.`
          );
        } catch (e) {
          if (e.name === "SequelizeUniqueConstraintError") {
            console.log(
              `notary ${notaryName} (${address}) already exists in the notary db.`
            );
          } else {
            console.log(
              `Something went wrong with adding notary: "${notaryName} (${address})" to the notary db.\n` +
                e
            );
          }
        }
      }
    } catch (error) {
      console.error(`error: ${error}`);
    }

    try {
      let state = await State.create({
        name: "lastBlock",
        RICK: 0,
        MORTY: 0,
        //  TXSCLAPOW: 0,
        KMD: 0,
      });
      console.log(`${state.name} created in State db`);
    } catch (e) {
      if (e.name === "SequelizeUniqueConstraintError") {
        console.log(`"lastBlock" already exists in the State db.`);
      } else {
        console.log(
          `Something went wrong with adding state: "${state.name}" to the State db.\n` +
            e
        );
      }
    }

    try {
      let state = await State.create({
        name: "totalNotarizations",
        RICK: 0,
        MORTY: 0,
        //  TXSCLAPOW: 0,
        KMD: 0,
      });
      console.log(`${state.name} created in State db`);
    } catch (e) {
      if (e.name === "SequelizeUniqueConstraintError") {
        console.log(`"totalNotarizations" already exists in the State db.`);
      } else {
        console.log(
          `Something went wrong with adding state: "${state.name}" to the State db.\n` +
            e
        );
      }
    }
    const SmartChains = [
      /*{ TXSCLAPOW: 0 },*/
      { MORTY: 857998 }, //2021 - initial: 830000
      { RICK: 854018 }, // 2021 - initial: 830000
    ];
    for (const chain of SmartChains) {
      let chainName = Object.keys(chain)[0];
      let start = chain[chainName];
      await processSmartChain(chainName, start);
    }
    let notaryData = await NotariesList.findAll({
      attributes: [
        "name",
        "address",
        "RICK",
        "MORTY",
        //  "TXSCLAPOW",
        "lastRICKNotaTxnIdStamp",
        "lastMORTYNotaTxnIdStamp",
        //  "lastTXSCLAPOWNotaTxnIdStamp",
      ],
    });

    let momentNow = moment();
    for (const chain of SmartChains) {
      let chainName = Object.keys(chain)[0];
      notaryData = notaryData.map((notary) => {
        if (notary instanceof NotariesList) {
          notary = notary.toJSON();
        }
        const timeStampLastNota = moment.unix(
          parseInt(notary[`last${chainName}NotaTxnIdStamp`].split(",")[1])
        );
        const notaTxId = notary[`last${chainName}NotaTxnIdStamp`].split(",")[0];
        notary[`notaTimeStamp${chainName}`] = timeStampLastNota;
        notary[`timeSinceNota${chainName}`] =
          Math.abs(
            moment.duration(timeStampLastNota.diff(momentNow)).asMinutes()
          ) < 45
            ? moment.duration(timeStampLastNota.diff(momentNow)).humanize(true)
            : moment
                .duration(timeStampLastNota.diff(momentNow))
                .humanize(true) +
              ` (${Math.round(
                Math.abs(
                  moment.duration(timeStampLastNota.diff(momentNow)).asMinutes()
                )
              )} minutes)`;
        delete notary[`last${chainName}NotaTxnIdStamp`];
        notary[`last${chainName}NotaTxnId`] = notaTxId;
        if (!timeStampLastNota.isValid()) {
          notary[`timeSinceNota${chainName}`] = "Never";
          notary[`notaTimeStamp${chainName}`] = "None";
          notary[`last${chainName}NotaTxnId`] = "None";
        }
        let chainData = {
          name: `${chainName}`,
          totalNotas: notary[`${chainName}`],
          lastNotaTimeStamp: notary[`notaTimeStamp${chainName}`],
          lastNotaTxnId: notary[`last${chainName}NotaTxnId`],
          timeSinceLastNota: notary[`timeSinceNota${chainName}`],
        };
        notary[`${chainName}`] = chainData;

        delete notary[`timeSinceNota${chainName}`];
        delete notary[`notaTimeStamp${chainName}`];
        delete notary[`last${chainName}NotaTxnId`];

        return notary;
      });
    }
    let chainTxnCounts = {};
    for (const chain of SmartChains) {
      let chainName = Object.keys(chain)[0];
      let txnData = await Transactions.findAll({
        attributes: ["notaries", "unixTimestamp", "txid"],
        where: {
          chain: chainName,
        },
      });
      let txnCountNotaries = {};
      for (const notary of notaryData) {
        let txnCount = { last24: 0, last72: 0, last168: 0 };
        txnData.forEach((txn) => {
          const timeStamp = moment.unix(parseInt(txn.unixTimestamp));
          const timeDiff = Math.abs(
            moment.duration(timeStamp.diff(momentNow)).asHours()
          );
          if (txn.notaries.includes(notary.address)) {
            if (timeDiff < 24) {
              txnCount["last24"]++;
              txnCount["last72"]++;
              txnCount["last168"]++;
            } else if (timeDiff < 72) {
              txnCount["last72"]++;
              txnCount["last168"]++;
            } else if (timeDiff < 168) {
              txnCount["last168"]++;
            }
          }
        });
        txnCountNotaries[notary.name] = txnCount;
      }
      chainTxnCounts[chainName] = txnCountNotaries;
    }
    notaryData = notaryData.map((notary) => {
      let name = notary.name;
      //notary["chains"] = [];
      for (const chain of SmartChains) {
        let chainName = Object.keys(chain)[0];
        notary[chainName]["pastCounts"] = chainTxnCounts[chainName][name];
        // notary["chains"].push(notary[chainName]);
        // delete notary[chainName];
      }
      return notary;
    });

    console.log(JSON.stringify(notaryData));

    await saveToAwsS3(
      "kmd-data",
      "notary-stats-2021/main.json",
      JSON.stringify(notaryData)
    );
    console.log(`
        --------------------------------------------------------------------------------------
        [Loop No: ${loopCount}] waiting 30 seconds before carrying on the next update                 
        --------------------------------------------------------------------------------------`);
    await delaySec(30);
    loopCount = loopCount + 1;
  }
})();
