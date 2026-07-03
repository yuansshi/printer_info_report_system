# Printer Information Report System

Fuji Xerox/Fujifilm Business Innovation 打印机邮件采集、历史保存、Excel 报表和运营 Dashboard 系统。系统从新浪邮箱以只读 IMAP 方式提取通知，关联客户与安装位置，并生成与现有 Excel 模板兼容的单日及多日报表。

当前状态：**内部试运行**。核心流程和 Dashboard 每日更新已可用，下一阶段重点是回归测试、计费器语义、告警和访问控制。

## 当前能力

- 按上海时区提取指定自然日的邮件，不修改邮箱已读状态。
- 解析中英文通知，以及使用“机身编号”和带缩进章节的旧版 Fuji Xerox 模板。
- 提取机器型号、机身编号、耗材、服务部件、故障和计费器原始内容。
- 使用客户映射表补充客户名称和安装位置。
- 生成与三个参考文件对应的单一工作簿：
  - `客户名称机身编号映射表`
  - `对比文件`
  - `打印机状态-YYYY-MM-DD-00001`
- 生成五日工作簿：每日状态页、设备信息汇总页和分析页。
- 生成从 2026-06-01 开始的本地运营 Dashboard，支持日/周/月趋势、筛选、设备检索、告警、计费器和数据质量检查。
- 按日期保存原始邮件与标准化状态，自动补缺口、保留变更版本并每日原子发布新快照。
- 在导出前执行表格检查、公式错误扫描和图片渲染验证。

## 项目文件

| 文件 | 作用 |
|---|---|
| `retrieve_printer_mail.py` | 只读 IMAP 提取、MIME 解码和通知标准化 |
| `printer_email_report.mjs` | 单日报表及三页签合并工作簿 |
| `five_day_printer_report.mjs` | 五日报表、设备汇总和分析页 |
| `run_printer_email_report.sh` | 当前单日交互式运行入口 |
| `update_printer_dashboard.py` | 历史回填、每日增量、质量门禁和 Dashboard 发布入口 |
| `dashboard_config.json` | Dashboard 起始日期、历史目录、映射表和更新参数 |
| `deploy/` | 远程 Linux systemd、Nginx 和环境配置示例 |
| `dashboard/` | 本地运营 Dashboard、数据构建脚本和静态数据快照 |
| `data/printer_history/` | 每日历史分区、运行清单、旧版本和日志；不提交源码仓库 |
| `workbook_analysis/` | 原始邮件 JSON、标准化 JSON、验证和预览文件 |
| `outputs/` | 最终 Excel 产物 |

## 参考输入

项目当前以以下三个工作簿作为数据和版式基准：

1. `客户名称机身编号映射表.xlsx`
2. `对比文件.xlsx`
3. `打印机状态-2026-06-20-00001.xlsx`

这些文件目前通过本机路径读取。路径配置化已列入首个项目里程碑。

## Dashboard 数据基线

- 历史起点：`2026-06-01`。
- 当前已验证范围：`2026-06-01` 至 `2026-07-02`。
- 4,178 封源邮件全部解析成功，覆盖 50 台设备。
- 日统计按上海自然日，周统计按周一至周日，月统计按自然月。
- 自动更新只发布到昨天，避免把尚未结束的当天数据计为完整日。

## 快速运行

先准备运行时文件，或使用 `PRINTER_ENV_FILE` 和 `PRINTER_MAPPING_PATH` 环境变量覆盖路径：

```text
config/mail.env
config/客户名称机身编号映射表.xlsx
```

从项目根目录生成单日报表：

```bash
python3 retrieve_printer_mail.py \
  --date 2026-07-02 \
  --output workbook_analysis/mail-2026-07-02.json \
  --normalized-output workbook_analysis/printer-states-2026-07-02.json

node printer_email_report.mjs \
  2026-07-02 \
  workbook_analysis/printer-states-2026-07-02.json \
  /path/to/客户名称机身编号映射表.xlsx \
  outputs/printer_email_2026-07-02/打印机状态-2026-07-02-00001.xlsx
```

上述命令同时生成三页签合并文件：

```text
outputs/printer_email_2026-07-02/打印机信息汇总-2026-07-02.xlsx
```

完整操作和故障处理见 [运行手册](docs/RUNBOOK.md)。

## 查看 Dashboard

手工执行一次完整更新，默认拉取到昨天这个最近完整日：

```bash
python3 update_printer_dashboard.py
```

本机文件位于其他目录时：

```bash
PRINTER_ENV_FILE=/path/to/mail.env \
PRINTER_MAPPING_PATH=/path/to/客户名称机身编号映射表.xlsx \
python3 update_printer_dashboard.py
```

首次或指定范围回填：

```bash
python3 update_printer_dashboard.py --from 2026-06-01 --to 2026-07-02 --force
```

启动本地静态服务器：

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory dashboard
```

浏览器打开 `http://127.0.0.1:4173/`。远程环境由 systemd timer、cron 或容器 CronJob 每日调用同一更新命令，示例见 [远程部署说明](deploy/README.md)。Dashboard 页面只读取生成后的静态快照；邮箱访问只发生在更新任务中。

## 文档

- [当前实现、架构和数据规则](docs/CURRENT_STATE.md)
- [运行手册](docs/RUNBOOK.md)
- [Dashboard 历史与自动更新架构](docs/DASHBOARD_ARCHITECTURE.md)
- [项目计划与改进路线图](docs/PROJECT_PLAN.md)

## 安全原则

- 邮箱凭据只保存在项目外部的 `.env` 中，不写入代码、日志或工作簿。
- IMAP 使用只读方式打开 INBOX，并使用 `BODY.PEEK` 获取邮件。
- 原始邮件可能包含客户、IP 地址和设备信息；`data/printer_history/`、`workbook_analysis/` 与 `outputs/` 应按内部数据处理，不应公开提交。
- Git 仓库只保存程序、配置示例、测试和文档；本地历史、生成报表、浏览器验证产物和凭据由 `.gitignore` 排除。
