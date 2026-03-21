import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
	root: "src",
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src/mainview"),
		},
	},
	build: {
		outDir: "../dist",
		emptyOutDir: true,
	},
	server: {
		host: "::",
		port: 5173,
		strictPort: true,
		hmr: { overlay: false },
	},
});
