import dts from "vite-plugin-dts";

// vite.config.js
import { defineConfig } from "vite";
import glob from "fast-glob";
const files = glob.sync(["./src/**/*.{ts,js}"]).map((file) => {
  const key = file.match(/(?<=\.\/src\/).*(?=\.ts|\.js)/);
  return [key[0], file];
});
const entries = Object.fromEntries(files);

export default defineConfig({
  build: {
    minify: false,
    sourcemap: true,
    lib: {
      name: "minECS",
      entry: entries,
      formats: ["es"],
    },
    rollupOptions: {
      external: ["ajv", "lodash", "toposort"],
    },
  },
  plugins: [dts()],
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
  },
});
