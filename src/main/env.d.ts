/**
 * The dictation helper's Swift source is bundled into the main process as a
 * string, so a fresh checkout can build it without any extra copy step.
 */
declare module "*.swift?raw" {
    const source: string;
    export default source;
}
