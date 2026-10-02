// Wrangler bundles .sql files as text modules
declare module '*.sql' {
  const text: string;
  export default text;
}
