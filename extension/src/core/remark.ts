// `styled-markdown/remark`: the remark plugin. The npm build points './index' at the main bundle,
// so this entry adds a few bytes instead of a second copy of the engine.
export { remarkSmd as default, remarkSmd } from './index';
export type { SmdPluginOptions, SmdFileData, SmdVFile, SmdTree, SmdNode } from './index';
