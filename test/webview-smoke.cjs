const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let passed = 0;

function check(name, condition) {
  if (!condition) {
    throw new Error(`FAIL: ${name}`);
  }
  passed += 1;
}

const source = fs.readFileSync(path.join(__dirname, "..", "media", "main.js"), "utf8");
const context = {
  __ZCODE_MARKDOWN_TEST__: true,
  acquireVsCodeApi: () => ({}),
  document: { getElementById: () => ({}) },
};
vm.createContext(context);
vm.runInContext(source, context, { filename: "media/main.js" });

const render = context.__ZCODE_MARKDOWN__.renderMarkdown;
const table = render("| Name | Result |\n| --- | --- |\n| Alice | **ok** |");
check("table wrapper", table.includes('<div class="table-scroll"><table>'));
check("table header", table.includes("<th>Name</th>") && table.includes("<th>Result</th>"));
check("table cells and inline markdown", table.includes("<td>Alice</td>") && table.includes("<strong>ok</strong>"));

const escaped = render("| Value |\n| --- |\n| <script>alert(1)</script> |");
check("table cells remain escaped", escaped.includes("&lt;script&gt;") && !escaped.includes("<script>"));

const paragraph = render("alpha | beta");
check("ordinary pipe text stays a paragraph", paragraph.includes("<p>alpha | beta</p>") && !paragraph.includes("<table>"));

console.log(`${passed} webview checks passed`);
