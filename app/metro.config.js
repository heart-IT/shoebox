const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const defaultConfig = getDefaultConfig(__dirname);

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    // The bare-pack worker bundle is an .mjs module.
    sourceExts: [...defaultConfig.resolver.sourceExts, 'mjs', 'cjs'],
  },
};

module.exports = mergeConfig(defaultConfig, config);
