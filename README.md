# Local Code Review Tool - 快速指南

## 1. 目录结构

```
review-tools/
├─ bin/            # Windows/macOS 运行脚本
├─ rules/          # Vue/Kotlin/Swift 扫描规则
├─ runner/         # Node.js 运行器 + HTML 模板
├─ vscode-ext/     # VS Code 扩展
├─ pack/           # 可执行打包脚本
└─ README.md       # 本文件
```

## 2. 依赖安装

1. **Ollama**  
   https://ollama.com/download  
   验证安装：

   ```bash
   ollama --version
   ```

2. **Python + Semgrep**

```bash
pip install semgrep
```

3. **Node 依赖（runner）**

```bash
cd runner
npm install
```

## 3. 命令行运行

### Windows

```cmd
bin\review.bat <项目路径> [基础分支] [目标分支]
```

### macOS / Linux

```bash
chmod +x bin/review
bin/review <项目路径> [基础分支] [目标分支]
```

### 对比两个分支的示例

```bash
# 对比 master 和 develop 分支
bin/review ./my-project master develop

# 对比 main 和当前分支（HEAD）
bin/review ./my-project main HEAD

# 对比 main 和 feature/xxx 分支
bin/review ./my-project main feature/xxx

# 只指定项目路径（自动检测：master/main -> 当前分支）
bin/review ./my-project
```

### 使用环境变量

```bash
# Windows
set CR_BASE_BRANCH=master
set CR_TARGET_BRANCH=develop
bin\review.bat <项目路径>

# macOS / Linux
export CR_BASE_BRANCH=master
export CR_TARGET_BRANCH=develop
bin/review <项目路径>
```

生成 `review-output/`：

- `semgrep.json` → 静态分析结果
- `diff.patch` → Git diff（两个分支之间的差异）
- `llm.json` → AI Code Review 输出
- `report.html` → HTML 报告（浏览器打开）

## 4. VS Code 扩展（可选）

1. 在 VS Code 中打开 `review-tools` 目录
2. 进入 `vscode-ext`，按 `F5` 运行扩展调试
3. 右键项目文件夹 → **Run Local Code Review**

支持文件类型：`.vue`, `.js`, `.ts`, `.kt`, `.swift`, `.java`

## 5. 快速打包可执行文件（可选）

### Windows

```bash
cd runner
npm install -g pkg
pkg . --targets node18-win-x64 --output ../pack/review-win.exe
```

把 `bin/review.bat` 和 `rules/` 放同目录即可

### macOS

- 使用 `pkg` 或 `electron-builder` 打包 `runner/index.js`
- 包含 `bin/review` 和 `rules/` 到 dmg 或 pkg

## 6. 注意事项

- Ollama 模型默认使用 `qwen2.5:1.5b`（可通过 `CR_MODEL` 环境变量修改）
- 项目最好是 Git 仓库（否则 diff 为空，仅做静态扫描）
- 如果不指定分支，默认对比 `master/main` 和当前分支（HEAD）
- 如果 `master` 和 `main` 都不存在，会自动与上一个 commit (`HEAD~1`) 对比
- 可扩展 `rules/*.yaml` 支持更多语言
- 可在 CI/CD 自动调用 `bin/review` 生成报告
