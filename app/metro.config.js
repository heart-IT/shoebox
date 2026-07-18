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
    extraNodeModules: {
      // bare-rpc runs on the app side too (it self-frames the IPC). It pulls
      // bare-stream, a Bare builtin absent under Hermes — bare-stream is just
      // a streamx re-export, and bare-rpc only needs its Readable/Writable,
      // which streamx provides. Alias it so the same RPC code runs both ends.
      'bare-stream': require.resolve('streamx'),
    },
  },
};

module.exports = mergeConfig(defaultConfig, config);
