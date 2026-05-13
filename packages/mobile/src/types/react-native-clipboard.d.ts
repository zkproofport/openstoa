// Ambient declaration so the mini-app's standalone tsc can resolve
// `@react-native-clipboard/clipboard`, which is physically installed in the
// host app and surfaced via Metro at bundle time.
// Only the surface we actually use is typed here.
declare module '@react-native-clipboard/clipboard' {
  interface ClipboardStatic {
    getString(): Promise<string>;
    setString(content: string): void;
    hasImage(): Promise<boolean>;
    getImage(): Promise<string>;
  }

  const Clipboard: ClipboardStatic;
  export default Clipboard;
}
