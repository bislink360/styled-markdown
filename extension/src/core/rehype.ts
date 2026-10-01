// `styled-markdown/rehype`: the rehype plugin. The npm build points './index' at the main bundle,
// so this entry adds a few bytes instead of a second copy of the engine.
export { rehypeSmd as default, rehypeSmd } from './index';
export type { SmdPluginOptions, SmdFileData, SmdVFile, SmdTree, SmdNode } from './index';
