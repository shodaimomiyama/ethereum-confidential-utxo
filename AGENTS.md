# エージェント向けガイド

## エージェント運用

### モデル

- 親エージェントとサブエージェントは、タスクで選択されたモデル設定を基本とする。
- 暗号、安全性、仕様の判断では精度を優先する。

### サブエージェント分担

独立して進められる調査、実装、レビューは、必要に応じてサブエージェントに自律的に委任する。

| 担当 | 責務 |
| --- | --- |
| 親エージェント | ユーザーとの合意、作業分解、結果の検証と統合、最終報告 |
| サブエージェント | 独立した調査、担当範囲を限定した実装、レビュー。重要な判断は根拠とともに親へ返す |

委任時は目的、担当範囲、期待する成果、編集対象を示す。
並列作業の編集対象が重複しないように分担する。

## ドキュメント索引

作業対象に対応する文書を読み、要求と対象範囲を確認する。

| 文書 | 対象 |
| --- | --- |
| [Confidential UTXOのPRD](docs/PRD.md) | 本体の要求、初期検証の範囲、標準化の目的 |
| [Confidential UTXOの要件定義](docs/requirements.md) | 本体の機能、安全性、機密性、形式証明、評価と再現性の受入条件 |
| [Confidential UTXOの仕様](docs/specification.md) | 方式に依存しない状態遷移、認可、資産保存、受領と同期の規則 |
| [Confidential UTXOのアーキテクチャ](docs/architecture.md) | 本体の構成、実装基盤、クライアントの境界、リポジトリと検証環境の構成方針 |
| [Confidential UTXOの設計（草案）](docs/design.md) | 方式、認可、受領と同期、検証計画、採用判断のための実験 |
| [Uniswap接続のPRD](docs/integration/uniswap/PRD.md) | Confidential UTXOから公開交換へ接続する際の要求と対象範囲 |
| [Uniswap接続の要件定義](docs/integration/uniswap/requirements.md) | 部分支払い、認可と取消、機密性、コストと追試の受入条件 |
| [Uniswap接続の仕様](docs/integration/uniswap/specification.md) | 支払いの受理と取消、全量着金、同期、公開サイトとデモ報酬要求の振る舞い |
| [Uniswap接続のアーキテクチャ](docs/integration/uniswap/architecture.md) | 接続・サイト・配布の構成、採用技術、配置と検証環境 |
| [Uniswap接続の設計](docs/integration/uniswap/design.md) | 接続固有の詳細規則、方式選定、復旧と成立性の証拠 |

## 規約

文書の作成、更新、移動、削除、調査結果の保存を行う前に、[文書管理ルール](.agents/rules/documentation.md)を読む。
新規Markdownファイルの作成承認、文書の役割と配置、調査資料の保存基準を定めている。
