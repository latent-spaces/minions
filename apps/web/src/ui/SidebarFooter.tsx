import { MessageCircleHeart } from 'lucide-react';

/** Bottom of the menu column: Give us feedback below the footer links; icon only in the collapsed rail. The account
 *  moved to the top bar (shell polish 2026-10-18, section 12). */
export function SidebarFooter({ onFeedback, collapsed = false }: { onFeedback: () => void; collapsed?: boolean }) {
  return <>
    <button type="button" className="k42-nav-link k42-nav-tour" title={collapsed ? 'Give us feedback' : undefined} onClick={onFeedback}><MessageCircleHeart size={18} aria-hidden="true" /><span className={collapsed ? 'k42-nav-text' : undefined}>Give us feedback</span></button>
  </>;
}
