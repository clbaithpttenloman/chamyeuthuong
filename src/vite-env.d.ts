// Augment Vite's ImportMetaEnv to add project-specific env vars.
// VITE_GOOGLE_CLIENT_ID must be set as a Cloudflare Pages build variable
// (and in .env / shell for local development). Missing at build time → the
// admin page shows a Vietnamese configuration-error message.
interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string
}
