#!/usr/bin/env node
/**
 * 项目全局分析工具
 * 用法：
 *   node runner/project-analyzer.js D:\Work\xingxiangjie
 *
 * 依赖：
 *   - 已经安装的 mustache（和原来的 runner 共用）
 *   - 本地 ollama （和 review 工具同一个）
 *   - 环境变量 PRJ_MODEL（可选，默认用 CR_MODEL，再默认 qwen2.5:1.5b）
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const fse = require("fs-extra");
const path = require("path");
const mustache = require("mustache");

// ---------- 参数 & 基本信息 ----------
const projectPath = process.argv[2];
if (!projectPath) {
  console.error("Usage: node project-analyzer.js <project-path>");
  process.exit(1);
}
const ROOT = path.join(__dirname, "..");
const OUTDIR = path.join(ROOT, "review-output");
fse.ensureDirSync(OUTDIR);

// 使用哪个模型
const modelName =
  process.env.PRJ_MODEL || process.env.CR_MODEL || "qwen2.5:1.5b";

// 尝试获取 git 分支/commit
let gitBranch = null;
let gitCommit = null;
try {
  gitBranch = execSync(`git -C "${projectPath}" rev-parse --abbrev-ref HEAD`, {
    encoding: "utf8",
  }).trim();
} catch (e) {
  gitBranch = null;
}
try {
  gitCommit = execSync(`git -C "${projectPath}" rev-parse --short HEAD`, {
    encoding: "utf8",
  }).trim();
} catch (e) {
  gitCommit = null;
}

// ---------- 工具函数：遍历项目 ----------
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".idea",
  ".vscode",
  "dist",
  "build",
  "coverage",
  ".cache",
]);

const INTEREST_EXT = new Set([".js", ".ts", ".vue"]);

function walkFiles(dir, baseDir, acc) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(baseDir, full);

    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      walkFiles(full, baseDir, acc);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (INTEREST_EXT.has(ext)) {
        acc.push({ full, rel, ext });
      }
    }
  }
}

// ---------- 工具函数：简单依赖解析 ----------
function extractDeps(code) {
  const deps = [];
  const importRe = /import\s+[^'"]*['"](.+?)['"]/g;
  const requireRe = /require\(\s*['"](.+?)['"]\s*\)/g;
  let m;
  while ((m = importRe.exec(code))) {
    deps.push(m[1]);
  }
  while ((m = requireRe.exec(code))) {
    deps.push(m[1]);
  }
  return Array.from(new Set(deps));
}

// ---------- 工具函数：调用 ollama ----------
function runOllama(prompt) {
  const p = spawnSync("ollama", ["run", modelName], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  if (p.error) throw p.error;
  const out = (p.stdout || p.stderr || "").trim();
  if (!out) throw new Error("empty output from ollama");
  return out;
}

// ---------- 第一步：收集所有文件 ----------
console.log("Scanning project files...");
const allFiles = [];
walkFiles(projectPath, projectPath, allFiles);
console.log(`Found ${allFiles.length} files (.js/.ts/.vue)`);

// ---------- 第二步：逐文件分析 ----------
const fileSummaries = [];
const perFileErrors = [];

for (const file of allFiles) {
  const { full, rel, ext } = file;
  let code = "";
  try {
    code = fs.readFileSync(full, "utf8");
  } catch (e) {
    perFileErrors.push({ file: rel, error: e.message || String(e) });
    continue;
  }

  // 只传前 400 行，避免 prompt 过大
  const lines = code.split(/\r?\n/);
  const limited = lines.slice(0, 400).join("\n");
  const deps = extractDeps(limited);

  const perFilePrompt = `
You are analyzing a single file from a Vue.js / JavaScript project.

File path (relative to project root): ${rel}
Extension: ${ext}

You will see part of the file content (up to ~400 lines). Based on this, answer concisely what this file does.

Return ONLY a JSON object with the following shape:

{
  "file": "relative path string",
  "role": "one short phrase describing the role, e.g. 'UI component', 'Vuex store', 'router config', 'form validation mixin', 'utility functions', 'API client', 'configuration', 'other'",
  "summary": "2-4 sentences of plain English explaining what this file does and how it fits into the app. No code, no JSON, no backticks.",
  "mainConcepts": ["short keywords like 'loan application', 'user profile', ..."],
  "risks": ["optional potential problems or smells, or empty array"],
  "notes": "optional extra notes, can be empty string"
}

Do NOT include any markdown fences.
Do NOT repeat the raw code.
Do NOT include any fields outside this schema.

Known import/require dependencies in this file:
${JSON.stringify(deps)}

--- FILE CONTENT (truncated) ---
${limited}
`;

  console.log(`Analyzing file with LLM: ${rel}`);
  try {
    const out = runOllama(perFilePrompt);
    fs.writeFileSync(
      path.join(OUTDIR, `file-${rel.replace(/[\\/]/g, "_")}.json`),
      out,
      "utf8"
    );

    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch (e) {
      perFileErrors.push({
        file: rel,
        error: "JSON parse error: " + e.message,
      });
      continue;
    }

    // 附上 deps（方便后面构建依赖图）
    parsed.deps = deps;
    fileSummaries.push(parsed);
  } catch (e) {
    perFileErrors.push({ file: rel, error: e.message || String(e) });
  }
}

// ---------- 第三步：构建简单依赖图 ----------
const depEdges = [];
for (const f of fileSummaries) {
  const from = f.file;
  const deps = Array.isArray(f.deps) ? f.deps : [];
  for (const d of deps) {
    // 只保留项目内的相对依赖
    if (d.startsWith(".") || d.startsWith("/")) {
      depEdges.push({ from, to: d });
    }
  }
}

// ---------- 第四步：让 LLM 做“全项目总结” ----------
const summaryPrompt = `
You are summarizing a front-end project (mostly Vue.js / JavaScript).

You will receive:
1) "files": an array of per-file summaries.
2) "deps": a list of dependency edges between files (from -> to).

Your job is to give a clear, high-level overview for developers and managers.

Return ONLY a JSON object with the following shape:

{
  "projectName": "short name guessed from structure or leave generic like 'Front-end App'",
  "techStack": ["Vue.js", "Vuex", "JavaScript", ...],
  "mainDomains": ["short phrases describing business domain, e.g. 'loan application', 'user onboarding'"],
  "layers": [
    { "name": "UI layer", "description": "what it does", "exampleFiles": ["src/pages/..", ...] },
    { "name": "State / Store layer", "description": "...", "exampleFiles": [...] },
    { "name": "Utility / Helpers", "description": "...", "exampleFiles": [...] }
  ],
  "keyDataFlows": [
    "short bullet describing how data flows between components/modules"
  ],
  "riskSummary": [
    "short bullets of important risks or code smells found across the project"
  ],
  "improvementIdeas": [
    "short bullets with concrete improvement suggestions for code structure, testing, DX, etc."
  ],
  "hotspotFiles": [
    { "file": "relative path", "reason": "e.g. 'complex business logic', 'many responsibilities', 'security sensitive code'" }
  ]
}

Rules:
- Use plain English.
- Do NOT include raw code.
- Do NOT include markdown fences.
- Be concise but meaningful.

Here is the project analysis input:

${JSON.stringify({ files: fileSummaries, deps: depEdges }).slice(0, 60000)}
`;

console.log("Running project-level summary with LLM...");
let projectSummary = {};
try {
  const out = runOllama(summaryPrompt);
  fs.writeFileSync(path.join(OUTDIR, "project-analysis.json"), out, "utf8");
  projectSummary = JSON.parse(out);
} catch (e) {
  console.warn("Project-level LLM summary failed:", e.message || e);
  projectSummary = {
    projectName: "Unknown Front-end Project",
    techStack: [],
    mainDomains: [],
    layers: [],
    keyDataFlows: [],
    riskSummary: [],
    improvementIdeas: [],
    hotspotFiles: [],
  };
}

// ---------- 第五步：渲染 HTML 报告 ----------
const TEMPLATE = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Project Overview / 项目全局分析报告</title>
  <style>
    body {
      font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      background:#f5f5f7;
      margin:0;
      padding:24px;
      color:#222;
    }
    .container { max-width:1100px;margin:0 auto; }
    h1 { margin:0 0 16px;font-size:28px; }
    h2 { margin-top:24px;font-size:20px; }
    h3 { margin-top:18px;font-size:16px; }
    .card {
      background:#fff;
      border-radius:10px;
      padding:16px 20px;
      margin-bottom:16px;
      box-shadow:0 2px 4px rgba(0,0,0,.05);
    }
    .meta-row { display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:#555; }
    .meta-item span.label { color:#999; }
    ul { padding-left:18px;font-size:14px; }
    li { margin:2px 0; }
    .file-list { font-size:13px;background:#fafafa;border-radius:6px;padding:8px 10px;max-height:200px;overflow:auto; }
    .file-item { margin:2px 0; }
    .badge {
      display:inline-block;
      padding:2px 8px;
      border-radius:999px;
      font-size:11px;
      background:#e3f2fd;
      color:#1565c0;
      margin-right:4px;
    }
    .small-note { font-size:12px;color:#777;margin-top:4px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Project Overview / 项目全局分析报告</h1>

    <div class="card">
      <div class="meta-row">
        <div class="meta-item">
          <span class="label">Project Root / 项目根目录：</span>
          <span>{{projectPath}}</span>
        </div>
        <div class="meta-item">
          <span class="label">Model / 模型：</span>
          <span>{{modelName}}</span>
        </div>
        <div class="meta-item">
          <span class="label">Scan Time / 扫描时间：</span>
          <span>{{scanAt}}</span>
        </div>
        <div class="meta-item">
          <span class="label">Git Branch：</span>
          <span>{{gitBranch}}</span>
        </div>
        <div class="meta-item">
          <span class="label">Git Commit：</span>
          <span>{{gitCommit}}</span>
        </div>
      </div>
      <div class="meta-row" style="margin-top:8px;">
        <div class="meta-item">
          <span class="label">Analyzed Files / 分析文件数：</span>
          <span>{{fileCount}}</span>
        </div>
      </div>
      <div class="small-note">
        说明：本报告基于本地代码目录扫描结果生成，与 GitLab CI 或远程分支无关，当前分支与 commit 信息仅用于标记本次分析来源。
      </div>
    </div>

    <div class="card">
      <h2>1. Project Summary / 项目整体概览</h2>
      <p><b>Project Name / 项目名称（推测）：</b> {{projectSummary.projectName}}</p>

      {{#projectSummary.techStack.length}}
      <p>
        <b>Tech Stack / 技术栈：</b>
        {{#projectSummary.techStack}}
          <span class="badge">{{.}}</span>
        {{/projectSummary.techStack}}
      </p>
      {{/projectSummary.techStack.length}}

      {{#projectSummary.mainDomains.length}}
      <h3>Business Domains / 业务领域</h3>
      <ul>
        {{#projectSummary.mainDomains}}
          <li>{{.}}</li>
        {{/projectSummary.mainDomains}}
      </ul>
      {{/projectSummary.mainDomains.length}}

      {{#projectSummary.keyDataFlows.length}}
      <h3>Key Data Flows / 关键数据流</h3>
      <ul>
        {{#projectSummary.keyDataFlows}}
          <li>{{.}}</li>
        {{/projectSummary.keyDataFlows}}
      </ul>
      {{/projectSummary.keyDataFlows.length}}
    </div>

    <div class="card">
      <h2>2. Layers / 项目分层</h2>
      {{#projectSummary.layers.length}}
        {{#projectSummary.layers}}
          <h3>{{name}}</h3>
          <p>{{description}}</p>
          {{#exampleFiles.length}}
          <div class="file-list">
            {{#exampleFiles}}
              <div class="file-item">{{.}}</div>
            {{/exampleFiles}}
          </div>
          {{/exampleFiles.length}}
        {{/projectSummary.layers}}
      {{/projectSummary.layers.length}}
      {{^projectSummary.layers.length}}
        <p>模型未能识别清晰的分层结构。</p>
      {{/projectSummary.layers.length}}
    </div>

    <div class="card">
      <h2>3. Risks & Improvements / 风险与改进建议</h2>

      {{#projectSummary.riskSummary.length}}
      <h3>Risk Summary / 风险概览</h3>
      <ul>
        {{#projectSummary.riskSummary}}
          <li>{{.}}</li>
        {{/projectSummary.riskSummary}}
      </ul>
      {{/projectSummary.riskSummary.length}}

      {{#projectSummary.improvementIdeas.length}}
      <h3>Improvement Ideas / 改进建议</h3>
      <ul>
        {{#projectSummary.improvementIdeas}}
          <li>{{.}}</li>
        {{/projectSummary.improvementIdeas}}
      </ul>
      {{/projectSummary.improvementIdeas.length}}
    </div>

    <div class="card">
      <h2>4. Hotspot Files / 关注文件</h2>
      {{#projectSummary.hotspotFiles.length}}
        <div class="file-list">
        {{#projectSummary.hotspotFiles}}
          <div class="file-item">
            <b>{{file}}</b> — {{reason}}
          </div>
        {{/projectSummary.hotspotFiles}}
        </div>
      {{/projectSummary.hotspotFiles.length}}
      {{^projectSummary.hotspotFiles.length}}
        <p>模型未标记明显的热点文件。</p>
      {{/projectSummary.hotspotFiles.length}}
    </div>

    <div class="card">
      <h2>5. Raw File Summaries / 文件级别摘要（调试用）</h2>
      <div class="small-note">
        只展示前 30 个文件，方便你验证模型是否看懂了项目结构。
      </div>
      <div class="file-list">
        {{#limitedFiles}}
          <div class="file-item">
            <b>{{file}}</b> — {{role}}<br/>
            <span style="font-size:12px;color:#555;">{{summary}}</span>
          </div>
        {{/limitedFiles}}
      </div>
    </div>
  </div>
</body>
</html>
`;

// 构造 view 并渲染
const scanAt = new Date().toLocaleString();
const view = {
  projectPath,
  modelName,
  scanAt,
  gitBranch: gitBranch || "(unknown)",
  gitCommit: gitCommit || "(unknown)",
  fileCount: fileSummaries.length,
  projectSummary,
  limitedFiles: fileSummaries.slice(0, 30),
};

const html = mustache.render(TEMPLATE, view);
const htmlPath = path.join(OUTDIR, "project-overview.html");
fs.writeFileSync(htmlPath, html, "utf8");

console.log("Project overview report generated at:", htmlPath);
if (perFileErrors.length) {
  console.log("Some files failed to analyze:", perFileErrors.length);
}
