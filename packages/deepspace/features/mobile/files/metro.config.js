const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// The app's schemas (and any other shared, dependency-free modules) live in ../src.
config.watchFolders = [path.resolve(__dirname, '../src')]

module.exports = config
