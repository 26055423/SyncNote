/**
 * 复盘面板顶部的「我的复盘」入口：不再展开列表，直接跳到交易日历。
 *
 * 列表/搜索都挪到 /history 里了（那边有日历、筛选和「马后炮笔记」），
 * 这里只保留一个跳转，点当前笔记时会带上 note 参数，落地后自动定位到那一天。
 */
export function ReviewNotesList({ current = null }: { current?: string | null }) {
  const href = '/history' + (current ? `?note=${encodeURIComponent(current)}` : '');
  return <a className="review-notes-jump" href={href} title="在交易日历里查看我的复盘（含马后炮笔记）">
    <span>我的复盘</span>
    <span className="review-notes-jump-arrow" aria-hidden="true">→</span>
  </a>;
}
