// Vite raw imports: `import text from './file.md?raw'` yields the file contents as a string.
declare module '*?raw' {
  const content: string;
  export default content;
}
