# 大任务列表按视口渲染

日期：2026-09-25。范围：独立 `VirtualTaskList` 组件、局部 CSS、精确版本依赖、合成数据浏览器验收。控制台/小窗接入及原生性能由主工作包记录；这里不将独立 fixture 当成完整 App 测量。

## 触发问题与选择

主工作包测得 10,000 任务小窗全量挂载约 408,000 DOM、初次操作约 4 秒，已明显影响使用。任务行有中文换行、元信息和四套密度，不能假定固定高度；两区仍需要各自原有滚动条。

采用 `@tanstack/react-virtual` **3.14.13**，其精确依赖 `@tanstack/virtual-core` **3.17.11**。只新增这两个 npm 包；package.json 固定直接版本，package-lock.json 保留完整性摘要。安装时 npm 报告 107 个包、0 条已知漏洞；这不是应用无漏洞证明。

一手 GitHub 参考已先读许可再核对 API：

- [官方动态高度示例固定提交](https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/examples/react/dynamic/src/main.tsx)：核对 `useVirtualizer`、既有 scroll element、测量 ref 和 scrollMargin 的坐标用法。
- [React 适配源码](https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/packages/react-virtual/src/index.tsx) / [核心源码](https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/packages/virtual-core/src/index.ts)：核对稳定 key、rangeExtractor 与 `anchorTo: 'end'` 的插入/移除锚点保持行为。`followOnAppend: false`，新增任务不自动跟随到末尾。
- [MIT 许可](https://github.com/TanStack/virtual/blob/78371e851e90fd74e984deeb0c3fd8098e2cd4f3/LICENSE)：Tanner Linsley，标准 MIT；未复制其示例或引擎代码。通过正式 npm 依赖调用公开 API，许可保存在包中。
- `git ls-remote` 核对 tag `@tanstack/react-virtual@3.14.13` 的解引用 commit 为上面的 `78371e…`；不引用浮动 main 作为版本证据。

## 接入契约

```tsx
const scrollRef = useRef<HTMLElement>(null); // 必须在 loading 提前 return 之前

<main ref={scrollRef} className="main-content">
  <VirtualTaskList
    items={tasks}
    renderItem={task => <TaskRow /* 原有任务与操作 props */ />}
    scrollRef={scrollRef}
    resetKey={`${page}:${query}:${sort}`}
    estimateSize={72}
    className="task-list"
    label="任务列表"
  />
</main>
```

`T extends { id: string }`，ID 必须唯一且稳定。`renderItem(item, index)` 接受现有任务行，不改业务含义；组件内不复制任务状态。`scrollRef` 指向现有 `.main-content` 或 `.edge-scroll`，不产生新滚动层。同一滚动容器的后续分组可各用组件，但只有主列表传 `resetKey`，避免完成组/此前未完成组重设整个容器的位置。主列表首次挂载或 `resetKey` 变化时回顶（包括从设置页切回），普通完成、移出或业务修订不回顶。

80 项及以下完整渲染；以上使用 TanStack Virtual 的动态测量与 6 行 overscan，不截取任务集合。组件为完整集合报告 `aria-setsize` / `aria-posinset`，保留外层 list 语义与原行按钮名称。局部 CSS 仅处理虚拟行定位及霜序首尾边角，不改字阶、配色、标题换行或小窗两行摘要。

父容器 ref 在首次子组件 layout effect 后才挂载，因此组件在提交后进行一次 observer 初始化；独立测试发现并修复过这一初次空列表问题。ResizeObserver 和 scrollMargin 处理长中文、改宽度与前置分组高度；相邻行位置取测量结果，不锁定估算高度。

## 键盘与操作连续性

- 焦点行在鼠标滚走后保持挂载，避免焦点落到 body。方向键在相邻任务的同一按钮位置间移动，Home / End 到首尾；遇输入/IME/组合快捷键不接管。
- Tab / Shift+Tab 跨尚未挂载的下一/上一行时先渲染再聚焦；在整个列表边界允许正常离开。现有任务行内多个按钮仍按原顺序 Tab。
- 完成或移出导致焦点任务消失时，在相邻任务上保留同类按钮位置；若焦点已进入详情或其他控件，不强行夺回。空列表聚焦自身，原生使用者能继续导航。
- 稳定 ID 与库内锚点逻辑使视口之前的插入/删除不把当前阅读项推走。搜索/页签/显式排序通过 resetKey 明确回顶。

## 验证证据与限制

`npx playwright test tests/virtual-list.spec.ts`：6 项通过；`npx tsc -b` 通过。测试覆盖 10,000 任务的有界 DOM、键盘末项可达、Tab 离开、跨未挂载行导航、搜索回顶、焦点行滚出保留、完成相邻接焦点、前十项移除锚点稳定、设置页切回重新挂载回顶，以及四风格和窄宽度的中文动态行高。图片检查发现连续切换宽度后首个 ResizeObserver 帧前保留旧高度；测试随后加强为等待实际测量后相邻行贴合（不是仅检查不重叠），最终截图已检查。无个人数据。

一次独立 Chrome / Vite 开发 fixture 测量：导航到首行出现 **91 ms**，总 DOM **173**，挂载任务行 **16**，列表总滚动高度约 **720,327 px**，无 pageerror。fixture 仅有 10,000 行列表和工具栏，不能直接与完整小窗原基线相除宣称性能倍数；待集成后用同一真实页面与相同数据复测。该证明任务未被静默截断：End 可到 task-9999，搜索末项可找到唯一结果。

浏览器检查没有代替 macOS WKWebView / Windows WebView2 的原生键盘、滚动与性能验收。动态测量在首次看到未测过的长行或改变宽度时会修正估算位置；应以集成后的真实观感和操作时间决定后续优化，不先引入缓存框架或自造虚拟引擎。
