const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

function activate(context) {
  let disposable = vscode.commands.registerCommand('localCodeReview.start', function (uri) {
    const folder = uri ? uri.fsPath : (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath);
    if (!folder) { vscode.window.showErrorMessage('Open a folder first.'); return; }

    const toolsDir = path.join(__dirname, '..');
    const bin = process.platform === 'win32' ? path.join(toolsDir,'bin','review.bat') : path.join(toolsDir,'bin','review');

    const terminal = vscode.window.createTerminal('Local Code Review');
    terminal.show();
    terminal.sendText(`"${bin}" "${folder}"`);
    vscode.window.showInformationMessage('Local Code Review started in terminal.');
  });

  context.subscriptions.push(disposable);
}

exports.activate = activate;
function deactivate() {}
module.exports = { activate, deactivate };
