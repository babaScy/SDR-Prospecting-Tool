// Set fake keys BEFORE any service module is required (the Anthropic/Apollo
// clients read env). Real network is never hit in unit tests.
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.APOLLO_API_KEY ||= 'test-key';

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;

async function connect() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'prospector-test' });
}

async function clear() {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
}

async function disconnect() {
  await mongoose.disconnect();
  await mongod.stop();
}

module.exports = { connect, clear, disconnect };
