import { loadEnvFiles } from "./load-env.js";

/**
 * Side-effect module that replaces `import "dotenv/config"`: import it once, as
 * early as possible in an entry point, to populate `process.env` from the
 * mode's `.env*` files. See {@link loadEnvFiles} for the precedence rules and
 * the `APP_ENV` mode selector.
 */
loadEnvFiles();
