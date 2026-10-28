import { renderMarkdown } from '/markdown.js';

const example = `\u8fd9\u5468\u4e3b\u8981\u5b8c\u6210\u4e86 **3 \u9879\u5de5\u4f5c**，\u6574\u4f53\u8fdb\u5c55\u987a\u5229。

## \u5df2\u5b8c\u6210\u7684\u5de5\u4f5c

1. **\u624b\u673a\u8bbf\u95ee**：\u63a5\u901a AIPA \u7f51\u9875，\u53ef\u4ee5\u968f\u65f6\u5bf9\u8bdd\u548c\u8bb0\u5f55\u60f3\u6cd5。
2. **\u5386\u53f2\u56de\u987e**：\u8865\u9f50\u65e5\u62a5\u4e0e\u4f1a\u8bdd\u65e5\u5fd7\u68c0\u7d22，\u56de\u7b54\u4f1a\u9644\u4e0a\u6765\u6e90。
3. **\u9605\u8bfb\u4f53\u9a8c**：\u8c03\u6574\u6bb5\u843d、\u5217\u8868\u548c\u4ee3\u7801\u6392\u7248，\u8ba9\u5185\u5bb9\u66f4\u5bb9\u6613\u9605\u8bfb。

> \u65e5\u5fd7\u8bb0\u8f7d\u7684\u662f\u5df2\u53d1\u751f\u7684\u5de5\u4f5c，\u5f85\u529e\u4f1a\u5355\u72ec\u5217\u51fa。

### \u4e0b\u4e00\u6b65

- [x] \u9a8c\u8bc1\u624b\u673a\u4e0a\u7684\u9605\u8bfb\u6548\u679c
- [ ] \u628a\u670d\u52a1\u8fc1\u79fb\u5230\u5e38\u5f00\u7684 Linux \u8bbe\u5907

### \u8fdb\u5c55\u4e00\u89c8

| \u4e8b\u9879 | \u72b6\u6001 | \u8bf4\u660e |
| --- | --- | --- |
| \u624b\u673a\u8bbf\u95ee | \u5df2\u5b8c\u6210 | HTTPS \u79c1\u6709\u5165\u53e3 |
| \u5e38\u9a7b\u90e8\u7f72 | \u5f85\u8fdb\u884c | \u8fc1\u79fb\u5230 Linux |

### \u542f\u52a8\u65b9\u5f0f

\u5728\u5b9e\u4f8b\u6240\u5728\u8bbe\u5907\u8fd0\u884c\u4ee5\u4e0b\u547d\u4ee4：

\`\`\`bash
node server.mjs --root /path/to/instance --engine claude
\`\`\`

\u5b8c\u6574\u8bf4\u660e\u89c1 [\u4f7f\u7528\u6587\u6863](https://example.com/guide)。`;

document.getElementById('example').append(renderMarkdown(example));
const checks = [];
function check(name, fn) { try { if (!fn()) throw new Error('\u65ad\u8a00\u5931\u8d25'); checks.push({ name, pass: true }); } catch (error) { checks.push({ name, pass: false, error: error.message }); } }
const sample = document.getElementById('example');
check('\u6807\u9898、\u52a0\u7c97\u4e0e\u5217\u8868\u6b63\u5e38\u6e32\u67d3', () => sample.querySelector('h2')?.textContent === '\u5df2\u5b8c\u6210\u7684\u5de5\u4f5c' && sample.querySelectorAll('strong').length >= 4 && sample.querySelectorAll('ol>li').length === 3);
check('\u8868\u683c\u9650\u5236\u5728\u72ec\u7acb\u6eda\u52a8\u533a\u57df', () => Boolean(sample.querySelector('.markdown-table>table')));
check('\u4ee3\u7801\u539f\u6587\u4fdd\u7559，\u590d\u5236\u6309\u94ae\u53ef\u7528', () => sample.querySelector('pre code')?.textContent.includes('--engine claude') && Boolean(sample.querySelector('.copy-code')));
check('\u4efb\u52a1\u9879\u4ec5\u4f5c\u53ea\u8bfb\u663e\u793a', () => [...sample.querySelectorAll('input')].length === 2 && [...sample.querySelectorAll('input')].every(input => input.disabled));
check('\u5916\u90e8\u94fe\u63a5\u9694\u79bb\u65b0\u7a97\u53e3', () => sample.querySelector('a')?.rel === 'noopener noreferrer' && sample.querySelector('a')?.target === '_blank');
const attack = renderMarkdown('<script>document.body.remove()</script><img src="https://example.invalid/tracker" onerror="alert(1)"><iframe src="https://example.invalid"></iframe><svg onload="alert(1)"></svg><p id="clobber" style="position:fixed" class="topbar" onclick="alert(1)">\u5b89\u5168\u6587\u5b57</p>\n\n[\u5371\u9669\u94fe\u63a5](javascript:alert(1))\n\n<a href="java&#x0A;script:alert(1)">\u53d8\u4f53</a><input type="text" autofocus>');
check('\u811a\u672c、\u5a92\u4f53\u4e0e\u53ef\u7f16\u8f91\u8868\u5355\u88ab\u6e05\u9664', () => !attack.querySelector('script,img,iframe,svg,style,input'));
check('\u4e8b\u4ef6、\u6837\u5f0f、ID \u548c\u9875\u9762\u6837\u5f0f\u7c7b\u88ab\u6e05\u9664', () => [...attack.querySelectorAll('*')].every(element => [...element.attributes].every(attr => !/^on|^style$|^id$|^name$|^class$/.test(attr.name))));
check('\u5371\u9669\u94fe\u63a5\u534f\u8bae\u88ab\u79fb\u9664', () => [...attack.querySelectorAll('a')].every(link => !link.hasAttribute('href')));
const code = renderMarkdown('```html\n<img src=x onerror=alert(1)>\n```');
check('\u4ee3\u7801\u793a\u4f8b\u4ee5\u6587\u672c\u663e\u793a，\u4e0d\u89e3\u91ca\u4e3a HTML', () => code.querySelector('code')?.textContent.includes('<img src=x onerror=alert(1)>') && !code.querySelector('img'));
for (const result of checks) {
  const line = document.createElement('li'); line.dataset.pass = String(result.pass);
  line.textContent = `${result.pass ? '\u901a\u8fc7' : "Failed"}: ${result.name}`; document.getElementById('test-results').append(line);
}
document.getElementById('test-status').textContent = `${checks.filter(check => check.pass).length}/${checks.length} \u9879\u6e32\u67d3\u9a8c\u8bc1\u901a\u8fc7`;
