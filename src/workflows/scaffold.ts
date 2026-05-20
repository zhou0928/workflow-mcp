import { z } from "zod";
import { zToJsonSchema } from "../utils/schema.js";
import type { ToolDefinition } from "../types.js";
import { exec } from "../utils/exec.js";
import { logger } from "../utils/logger.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";

// ============================================================
// Scaffold Init Schema
// ============================================================
const ScaffoldInitSchema = z.object({
  template: z.string().describe("Template name (e.g. vue3-app, node-ts, react-app, next-app, express-api)"),
  name: z.string().describe("Project name"),
  outputDir: z.string().optional().describe("Output directory (default: ./<name>)"),
  vars: z.record(z.string()).optional().describe("Template variables (overrides defaults)"),
  force: z.boolean().optional().describe("Overwrite existing directory"),
});

// ============================================================
// Scaffold Add Module Schema
// ============================================================
const ScaffoldAddModuleSchema = z.object({
  module: z.string().describe("Module type (e.g. vue-component, vite-plugin, express-route)"),
  name: z.string().describe("Module name"),
  directory: z.string().optional().describe("Project directory (default: current working directory)"),
});

// ============================================================
// Built-in templates
// ============================================================

interface TemplateFile {
  path: string;
  content: string;
}

interface Template {
  description: string;
  files: (name: string, vars: Record<string, string>) => TemplateFile[];
}

const TEMPLATES: Record<string, Template> = {
  "vue3-app": {
    description: "Vue 3 + Vite + TypeScript project",
    files: (name, vars) => {
      const pkgName = vars.packageName ?? name;
      return [
        {
          path: "package.json",
          content: JSON.stringify(
            {
              name: pkgName,
              version: "0.1.0",
              private: true,
              type: "module",
              scripts: { dev: "vite", build: "vue-tsc && vite build", preview: "vite preview" },
              dependencies: { vue: "^3.5.0" },
              devDependencies: { vite: "^6.0.0", "@vitejs/plugin-vue": "^5.0.0", typescript: "^5.7.0", "vue-tsc": "^2.0.0" },
            },
            null,
            2,
          ),
        },
        {
          path: "index.html",
          content: `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${name}</title></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>`,
        },
        {
          path: "vite.config.ts",
          content: `import { defineConfig } from "vite";\nimport vue from "@vitejs/plugin-vue";\nexport default defineConfig({ plugins: [vue()] });\n`,
        },
        {
          path: "tsconfig.json",
          content: JSON.stringify(
            {
              compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, jsx: "preserve", resolveJsonModule: true, isolatedModules: true, esModuleInterop: true, skipLibCheck: true },
              include: ["src/**/*.ts", "src/**/*.vue"],
            },
            null,
            2,
          ),
        },
        {
          path: "src/main.ts",
          content: `import { createApp } from "vue";\nimport App from "./App.vue";\ncreateApp(App).mount("#app");\n`,
        },
        {
          path: "src/App.vue",
          content: `<script setup lang="ts">\nimport { ref } from "vue";\nconst count = ref(0);\n</script>\n\n<template>\n  <div style="text-align:center;padding:4rem;font-family:sans-serif">\n    <h1>${name}</h1>\n    <p>count: {{ count }}</p>\n    <button @click="count++">+1</button>\n  </div>\n</template>\n`,
        },
        {
          path: "src/env.d.ts",
          content: `/// <reference types="vite/client" />\ndeclare module "*.vue" {\n  import type { DefineComponent } from "vue";\n  const component: DefineComponent<object, object, unknown>;\n  export default component;\n}\n`,
        },
      ];
    },
  },
  "node-ts": {
    description: "Node.js + TypeScript project with ESM",
    files: (name, vars) => {
      const pkgName = vars.packageName ?? name;
      return [
        {
          path: "package.json",
          content: JSON.stringify(
            {
              name: pkgName,
              version: "0.1.0",
              private: true,
              type: "module",
              scripts: { build: "tsc", start: "node dist/index.js", dev: "tsx watch src/index.ts" },
              dependencies: {},
              devDependencies: { typescript: "^5.7.0", tsx: "^4.0.0", "@types/node": "^22.0.0" },
            },
            null,
            2,
          ),
        },
        {
          path: "tsconfig.json",
          content: JSON.stringify(
            { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", outDir: "dist", rootDir: "src", strict: true, esModuleInterop: true, skipLibCheck: true, resolveJsonModule: true, declaration: true, sourceMap: true }, include: ["src/**/*"] },
            null,
            2,
          ),
        },
        { path: "src/index.ts", content: `console.log("Hello from ${name}!");\n` },
        { path: "src/utils.ts", content: `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n` },
        { path: ".gitignore", content: "node_modules\ndist\n.env\n" },
      ];
    },
  },
  "react-app": {
    description: "React 19 + Vite + TypeScript project",
    files: (name, vars) => {
      const pkgName = vars.packageName ?? name;
      return [
        {
          path: "package.json",
          content: JSON.stringify(
            {
              name: pkgName,
              version: "0.1.0",
              private: true,
              type: "module",
              scripts: { dev: "vite", build: "tsc && vite build", preview: "vite preview" },
              dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
              devDependencies: { vite: "^6.0.0", "@vitejs/plugin-react": "^4.0.0", typescript: "^5.7.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0" },
            },
            null,
            2,
          ),
        },
        {
          path: "index.html",
          content: `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${name}</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
        },
        {
          path: "vite.config.ts",
          content: `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n`,
        },
        {
          path: "tsconfig.json",
          content: JSON.stringify(
            { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, jsx: "react-jsx", resolveJsonModule: true, isolatedModules: true, esModuleInterop: true, skipLibCheck: true }, include: ["src"] },
            null,
            2,
          ),
        },
        {
          path: "src/main.tsx",
          content: `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);\n`,
        },
        {
          path: "src/App.tsx",
          content: `import { useState } from "react";\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <div style={{ textAlign: "center", padding: "4rem", fontFamily: "sans-serif" }}>\n      <h1>${name}</h1>\n      <p>count: {count}</p>\n      <button onClick={() => setCount((c) => c + 1)}>+1</button>\n    </div>\n  );\n}\n`,
        },
        { path: "src/App.css", content: `body { margin: 0; }\n` },
      ];
    },
  },
  "next-app": {
    description: "Next.js 15 + TypeScript + App Router project",
    files: (name, vars) => {
      const pkgName = vars.packageName ?? name;
      return [
        {
          path: "package.json",
          content: JSON.stringify(
            {
              name: pkgName,
              version: "0.1.0",
              private: true,
              scripts: { dev: "next dev", build: "next build", start: "next start" },
              dependencies: { next: "^15.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
              devDependencies: { typescript: "^5.7.0", "@types/node": "^22.0.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0" },
            },
            null,
            2,
          ),
        },
        {
          path: "next.config.ts",
          content: `import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n`,
        },
        {
          path: "tsconfig.json",
          content: JSON.stringify({ compilerOptions: { target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true, jsx: "preserve", incremental: true, plugins: [{ name: "next" }] }, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"], exclude: ["node_modules"] }, null, 2),
        },
        { path: "app/layout.tsx", content: `import type { Metadata } from "next";\nexport const metadata: Metadata = { title: "${name}" };\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="zh-CN">\n      <body>{children}</body>\n    </html>\n  );\n}\n` },
        { path: "app/page.tsx", content: `export default function Home() {\n  return <div style={{ textAlign: "center", padding: "4rem" }}><h1>${name}</h1><p>Welcome!</p></div>;\n}\n` },
        { path: "public/.gitkeep", content: "" },
      ];
    },
  },
  "express-api": {
    description: "Express.js + TypeScript API server",
    files: (name, vars) => {
      const pkgName = vars.packageName ?? name;
      return [
        {
          path: "package.json",
          content: JSON.stringify(
            {
              name: pkgName,
              version: "0.1.0",
              private: true,
              type: "module",
              scripts: { build: "tsc", start: "node dist/index.js", dev: "tsx watch src/index.ts" },
              dependencies: { express: "^5.0.0" },
              devDependencies: { typescript: "^5.7.0", tsx: "^4.0.0", "@types/node": "^22.0.0", "@types/express": "^5.0.0" },
            },
            null,
            2,
          ),
        },
        {
          path: "tsconfig.json",
          content: JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", outDir: "dist", rootDir: "src", strict: true, esModuleInterop: true, skipLibCheck: true, resolveJsonModule: true, declaration: true, sourceMap: true }, include: ["src/**/*"] }, null, 2),
        },
        {
          path: "src/index.ts",
          content: `import express from "express";\nconst app = express();\nconst port = process.env.PORT ?? 3000;\n\napp.get("/", (_req, res) => {\n  res.json({ name: "${name}", status: "ok" });\n});\n\napp.listen(port, () => {\n  console.log(\`${name} running on http://localhost:\${port}\`);\n});\n`,
        },
        { path: "src/routes/health.ts", content: `import { Router } from "express";\nconst router = Router();\nrouter.get("/health", (_req, res) => {\n  res.json({ status: "healthy", timestamp: new Date().toISOString() });\n});\nexport default router;\n` },
        { path: ".gitignore", content: "node_modules\ndist\n.env\n" },
      ];
    },
  },
};

// ============================================================
// Tool factory
// ============================================================

export function getScaffoldTools(): ToolDefinition[] {
  return [
    {
      name: "scaffold_init",
      description: `Scaffold a new project from a built-in template. Available templates: ${Object.entries(TEMPLATES).map(([k, v]) => `${k} (${v.description})`).join(", ")}`,
      inputSchema: zToJsonSchema(ScaffoldInitSchema),
      handler: async (args) => {
        try {
          const { template, name, outputDir, vars, force } = ScaffoldInitSchema.parse(args);

          const tmpl = TEMPLATES[template];
          if (!tmpl) {
            return {
              content: [{ type: "text", text: `❌ Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(", ")}` }],
              isError: true,
            };
          }

          const outDir = outputDir ?? join(process.cwd(), name);

          if (existsSync(outDir)) {
            if (!force) {
              return { content: [{ type: "text", text: `❌ Directory already exists: ${outDir}. Use force: true to overwrite.` }], isError: true };
            }
            logger.warn(`Overwriting existing directory: ${outDir}`);
          } else {
            mkdirSync(outDir, { recursive: true });
          }

          const mergedVars = { ...vars, name, packageName: (vars?.packageName ?? name).toLowerCase().replace(/\s+/g, "-") };

          const files = tmpl.files(name, mergedVars);
          let created = 0;

          for (const f of files) {
            const fullPath = join(outDir, f.path);
            mkdirSync(dirname(fullPath), { recursive: true });
            writeFileSync(fullPath, f.content, "utf-8");
            created++;
          }

          return {
            content: [
              {
                type: "text",
                text: [
                  `✅ Project "${name}" created from template "${template}"`,
                  `   Location: ${outDir}`,
                  `   Files created: ${created}`,
                  ``,
                  `   Next steps:`,
                  `     cd ${outDir}`,
                  `     npm install`,
                  `     npm run dev`,
                ].join("\n"),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
    {
      name: "scaffold_add_module",
      description: "Add a module (component, route, plugin) to an existing project",
      inputSchema: zToJsonSchema(ScaffoldAddModuleSchema),
      handler: async (args) => {
        try {
          const { module, name, directory } = ScaffoldAddModuleSchema.parse(args);
          const projectDir = directory ?? process.cwd();

          if (!existsSync(projectDir)) {
            return { content: [{ type: "text", text: `❌ Directory not found: ${projectDir}` }], isError: true };
          }

          // Detect project type from package.json
          const pkgPath = join(projectDir, "package.json");
          if (!existsSync(pkgPath)) {
            return { content: [{ type: "text", text: "❌ No package.json found in project directory." }], isError: true };
          }

          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          const hasVue = !!(pkg.dependencies?.vue || pkg.devDependencies?.vue);
          const hasReact = !!(pkg.dependencies?.react || pkg.devDependencies?.react);

          let created = 0;

          if (module === "vue-component" && hasVue) {
            const compPath = join(projectDir, "src", "components", `${name}.vue`);
            mkdirSync(dirname(compPath), { recursive: true });
            writeFileSync(
              compPath,
              `<script setup lang="ts">\ndefineProps<{ msg?: string }>();\n</script>\n\n<template>\n  <div class="${name.toLowerCase()}">\n    {{ msg ?? "${name} component" }}\n  </div>\n</template>\n\n<style scoped>\n.${name.toLowerCase()} {\n  padding: 1rem;\n}\n</style>\n`,
              "utf-8",
            );
            created++;
          } else if (module === "react-component" && hasReact) {
            const compPath = join(projectDir, "src", "components", `${name}.tsx`);
            mkdirSync(dirname(compPath), { recursive: true });
            writeFileSync(
              compPath,
              `interface ${name}Props {\n  msg?: string;\n}\n\nexport default function ${name}({ msg }: ${name}Props) {\n  return <div className="${name.toLowerCase()}">{msg ?? "${name} component"}</div>;\n}\n`,
              "utf-8",
            );
            created++;
          } else if (module === "express-route") {
            const routePath = join(projectDir, "src", "routes", `${name}.ts`);
            mkdirSync(dirname(routePath), { recursive: true });
            writeFileSync(
              routePath,
              `import { Router } from "express";\nconst router = Router();\n\nrouter.get("/${name.toLowerCase()}", (_req, res) => {\n  res.json({ module: "${name}", status: "ok" });\n});\n\nexport default router;\n`,
              "utf-8",
            );
            created++;
          } else {
            // Generic file generation
            const ext = hasVue ? ".vue" : hasReact ? ".tsx" : ".ts";
            const genPath = join(projectDir, "src", module, `${name}${ext}`);
            mkdirSync(dirname(genPath), { recursive: true });
            writeFileSync(genPath, `// ${name} module\n// TODO: implement\n`, "utf-8");
            created++;
          }

          return {
            content: [{ type: "text", text: `✅ Module "${name}" (${module}) added. ${created} file(s) created.` }],
          };
        } catch (err) {
          const message = err instanceof z.ZodError ? err.errors.map((e) => e.message).join(", ") : String(err);
          return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
        }
      },
    },
  ];
}
