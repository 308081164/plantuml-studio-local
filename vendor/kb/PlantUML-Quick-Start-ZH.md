# PlantUML 语法速查（应用内）

> 面向本工作室「大纲源码框」可直接粘贴使用的常见写法。完整规范见 [plantuml.com](https://plantuml.com/zh/guide)。

## 1. 基本结构

每种图都以 `@start…` 与 `@end…` 成对包裹：

```plantuml
@startuml
Alice -> Bob : 你好
@enduml
```

常见图种首行：

| 图种 | 首行 |
|------|------|
| 通用 UML | `@startuml` |
| 活动/流程 | `@startuml activity` |
| Chen ER | `@startchen` |
| WBS 结构 | `@startwbs` |
| 甘特 | `@startgantt` |

## 2. 时序图（Sequence）

```plantuml
@startuml
actor 用户
participant 系统
用户 -> 系统 : 提交订单
activate 系统
系统 --> 用户 : 返回单号
deactivate 系统
@enduml
```

要点：`->` 实线箭头，`-->` 虚线返回；`activate`/`deactivate` 表示生命线激活。

## 3. 类图（Class）

```plantuml
@startuml
class User {
  +name: String
  +login()
}
class Order {
  +id: int
}
User "1" -- "many" Order : 下单
@enduml
```

关系：`--` 关联，`<|--` 继承，`..>` 依赖，`*--` 组合。

## 4. 活动图 / 流程图

```plantuml
@startuml activity
start
:接收请求;
if (参数合法?) then (是)
  :处理业务;
else (否)
  :返回错误;
endif
stop
@enduml
```

国内高校模式常用 `:步骤; <<task>>`（处理）、`:输入; <<save>>`（数据）、`if (条件) then`（判定）。

## 5. 用例图（Use Case）

```plantuml
@startuml
left to right direction
actor 用户
rectangle 系统 {
  用户 --> (登录)
  用户 --> (查询订单)
}
@enduml
```

## 6. 组件图 / 部署图

```plantuml
@startuml
[Web 前端] --> [API 服务] : HTTP
[API 服务] --> [数据库]
@enduml
```

## 7. Chen ER 图

```plantuml
@startchen
entity "学生" as Student {
  学号 <<key>>
  姓名
}
entity "课程" as Course {
  课程号 <<key>>
  课程名
}
Student -N- Course
@endchen
```

注意：Chen 图**不要**使用 `note` 指令。

## 8. WBS 工作分解

```plantuml
@startwbs
* 电商系统
** 用户模块
*** 注册
*** 登录
** 订单模块
@endwbs
```

## 9. 常用排版

```plantuml
@startuml
title 我的图标题
skinparam backgroundColor #FFFFFF
skinparam defaultFontName Microsoft YaHei
@enduml
```

- `title` 单行标题（勿在 title 内写 `\n`）
- `skinparam` 控制颜色、字体、圆角等
- `left to right direction` 改变默认方向

## 10. 在本工作室中的建议

1. 先在「大纲源码框」写一版可渲染底稿，再用 Agent 自然语言「在现有基础上修改…」。
2. 渲染失败时查看状态栏或「文件 → 查看错误日志」，根据行号修正语法。
3. 复杂图拆成多个 `@startuml` 文件或在一张图中用 `package`/`partition` 分区。
4. 智能生成结果写入源码框后，可手动微调再点「渲染预览」验证。
