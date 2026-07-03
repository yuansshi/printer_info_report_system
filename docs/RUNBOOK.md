# 运行手册

## 1. 前置条件

- Python 3.11 或更高版本。
- Node.js 运行环境。Dashboard 构建无需额外 npm 包；Excel 工作簿生成仍需要 `@oai/artifact-tool`。
- 外部 `.env` 文件，包含以下键：
  - `sina_username`
  - `sina_imap_authorization_code`，优先使用
  - `sina_password`，仅作为兼容回退
  - `sina_url`，可选
- 客户映射表 `客户名称机身编号映射表.xlsx`。

不要把 `.env`、授权码或原始邮件提交到公开仓库。

## 2. 生成单日报表

### 2.1 从 IMAP 提取

```bash
python3 retrieve_printer_mail.py \
  --date 2026-07-02 \
  --output workbook_analysis/mail-2026-07-02.json \
  --normalized-output workbook_analysis/printer-states-2026-07-02.json
```

正常输出应同时报告：邮箱中符合日期的邮件数、成功解析的打印机通知数、两个 JSON 文件路径。

### 2.2 生成 Excel

```bash
node printer_email_report.mjs \
  2026-07-02 \
  workbook_analysis/printer-states-2026-07-02.json \
  /path/to/客户名称机身编号映射表.xlsx \
  outputs/printer_email_2026-07-02/打印机状态-2026-07-02-00001.xlsx
```

主要交付物是同目录下的：

```text
打印机信息汇总-2026-07-02.xlsx
```

该文件包含映射表、全部通知对比表和去重状态表三个页签。

## 3. 从已保存邮件重新解析

修改解析规则后，应优先使用已保存的原始 JSON 复测，避免重复访问邮箱：

```bash
python3 retrieve_printer_mail.py \
  --date 2026-07-02 \
  --input-json workbook_analysis/mail-2026-07-02.json \
  --normalized-output workbook_analysis/printer-states-2026-07-02.json
```

## 4. 生成五日报表

当前版本的日期在 `five_day_printer_report.mjs` 顶部配置：

```js
const dates = ["2026-06-28", "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"];
```

准备好每一天的原始及标准化 JSON 后运行：

```bash
node five_day_printer_report.mjs
```

将日期范围改为命令行参数是项目计划中的 P0 工作，不应长期依赖手工修改脚本。

## 5. 查看和刷新 Dashboard

手工更新到昨天：

```bash
python3 update_printer_dashboard.py
```

该命令检查从 `dashboard_config.json` 中 `start_date` 到昨天的全部日期，补抓缺失日，重抓最近 3 天，执行质量门禁并原子发布 `dashboard/data.js`。

指定范围强制回填：

```bash
python3 update_printer_dashboard.py --from 2026-06-01 --to 2026-07-02 --force
```

不访问邮箱，仅验证历史并重建 Dashboard：

```bash
python3 update_printer_dashboard.py --rebuild-only
```

启动本地服务器：

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory dashboard
```

浏览器打开 `http://127.0.0.1:4173/`。

远程每日更新由 systemd timer、cron 或容器 CronJob 调用相同命令。Linux systemd、Nginx、配置和目录权限示例见 `deploy/README.md`。更新进程必须能写历史目录和发布目录，并能读取 IMAP 凭据与客户映射表。

## 6. 发布前检查

每次交付必须确认：

1. 邮箱邮件数与成功解析数一致，或未解析邮件已经人工分类。
2. 所有状态时间属于请求的日期或明确的截止窗口。
3. 未匹配机身编号和缺失位置已在结果中列出。
4. 映射表页与源映射文件一致。
5. `对比文件` 行数等于有效通知数。
6. `打印机状态` 可由 `对比文件` 使用既定规则重复生成。
7. Excel 内没有 `#REF!`、`#VALUE!`、`#DIV/0!`、`#NAME?` 或意外的 `#N/A`。
8. 每个页签均完成图片渲染检查，表头、换行和长文本没有遮挡。
9. 最终 `.xlsx` 能重新导入并通过 ZIP 完整性检查。
10. Dashboard 的每日分区连续、UID 唯一、状态 UID 均能找到源邮件，且 `latest-run.json` 为成功状态。

## 7. 常见问题

### 登录失败

- 确认使用新浪 IMAP 授权码而不是网页登录密码。
- 确认账号已开启 IMAP 服务。
- 检查 `.env` 键名和值是否有多余引号或空格。

### 邮箱有邮件但解析数较少

- 比较原始 JSON 和标准化 JSON 的 UID。
- 检查新模板是否使用新的型号、序列号或章节标签。
- 将匿名化样本加入回归测试后再修改解析器。

### 客户或位置显示占位提示

- 在映射表中查找对应机身编号。
- 检查机身编号是否被 Excel 转为数值、科学计数法或丢失前导零。
- 不要在生成逻辑中静默猜测客户或位置。

### 计费器无法解释

- 保留邮件中的原始 `计费器[1]-[5]` 数值。
- 根据具体机器型号查找 Fuji Xerox/Fujifilm BI 计费器定义。
- 在定义确认前，不要把字段直接标记为黑白、彩色、复印或扫描。

### Dashboard 数据没有更新

- 查看 `data/printer_history/logs/stderr.log` 和 `last-failed-run.json`。
- 运行 `python3 update_printer_dashboard.py`，检查缺失日期、登录或解析率错误。
- 只需要重新发布时运行 `python3 update_printer_dashboard.py --rebuild-only`。
- 浏览器强制刷新，避免继续使用旧的 `data.js` 缓存。

## 8. 安全和回滚

- 邮箱读取流程不应执行移动、删除、标记已读或写入操作。
- 每日分区内容变化前会进入 `data/printer_history/revisions/`，成功运行清单包含 SHA-256。
- Dashboard 构建失败时不替换上一版 `dashboard/data.js`。
- 解析规则变更后，使用保存的 JSON 回放并与已验证日期比较。
- 发布新版本前保留上一份工作簿和验证清单，以便回滚。
