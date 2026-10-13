import { existsSync } from "node:fs";

// Scripts read the same env files Next.js does.
for (const file of [".env.local", ".env"]) if (existsSync(file)) process.loadEnvFile(file);
