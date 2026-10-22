---
name: pdf
description: 读取本地 PDF 的正文、页码和表格文字，按指定页面查找或总结内容；不适用于扫描件 OCR 或排版渲染。
---

# PDF 读取

此 Skill 使用 Axon 配套的 `axon-doc` 命令。它不是新的工具或额外授权；执行仍通过 Bash，遵守当前沙箱与审批。

1. 确认用户提供或附件清单中的 PDF 路径。不要猜测文件内容，也不要执行附件。
2. 用 Bash 在合适的 `workdir` 下执行范围提取；路径必须作为独立、正确引用的参数。

   ```sh
   axon-doc extract --input "/path/report.pdf" --start 1 --end 5 --max-chars 20000
   ```

3. 读取 JSON 的 `sections`。PDF 的 `number` 是从 1 开始的页码；总结或引用时保留文件名和页码。
4. `hasMore` 或 `truncated` 为 true 时，不要声称已读完整份文件。按任务需要缩小范围或继续读取后续页；正文预算耗尽时，同页可能也需要缩小任务或说明限制。
5. 如果没有提取到文字，说明此范围没有可读取的文本，可能是扫描页。不要把空结果当作 OCR 成功。

复杂表格的文字不保证保留原始列对齐。不要据此臆造单元格关系。当前不提供 OCR、页面渲染、填写表单或生成 PDF。

范围、限制和错误处理见 `references/extraction.md`，需要时通过 SkillRead 读取。
