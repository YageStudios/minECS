import dts from "vite-plugin-dts";
import { resolve } from "path";

// vite.config.js
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    minify: false,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, "./src/index.ts"),
      name: "minECS",
      formats: ["es"],
      // the proper extensions will be added
      fileName: "minecs",
    },
    rollupOptions: {
      external: ["ajv", "lodash", "toposort"],
    },
  },
  plugins: [
    dts({
      rollupTypes: true,
    }),
  ],
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
  },
});
