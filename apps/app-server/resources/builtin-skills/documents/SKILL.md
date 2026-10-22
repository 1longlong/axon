---
name: documents
description: 读取本地 DOCX 的正文、段落和表格行，查找或总结文档内容；不提供 Office 自动化、宏执行或排版渲染。
---

# DOCX 读取

使用 Axon 的 `axon-doc` 读取文档，命令通过普通 Bash 执行，不改变审批或沙箱权限。

1. 从用户输入或附件清单确认确切的 `.docx` 路径。旧 `.doc`、加密文档和远程在线文档不属于此能力。
2. 提取有界内容，不将压缩的 DOCX 二进制当作普通文本读取。

   ```sh
   axon-doc extract --input "/path/report.docx" --start 1 --end 20 --max-chars 20000
   ```

3. JSON `sections` 按阅读顺序编号：`paragraph` 为正文段落，`tableRow` 为用 ` | ` 分隔的表格行文字。编号不是原文页码。
4. 用 `totalSections`、`hasMore` 和 `truncated` 判断是否需要继续读取。任务涉及某个表格时，要同时读取表头及相关行，不只凭孤立数值下结论。
5. 回答保留文件名及相应段/行编号。字体、分页、合并单元格和复杂嵌套结构不保证还原，不声称已经检查视觉排版。

此命令不执行宏、不加载文档外部文件、不渲染文档中的 HTML。当前不提供编辑、修订、Office 自动化或生成 DOCX。

更多限制与错误处理见 `references/extraction.md`，需要时通过 SkillRead 读取。
