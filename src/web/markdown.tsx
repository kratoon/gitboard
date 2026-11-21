import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { internalClick, remarkIssueKeys, useLinks } from './links';
import { normalizeMarkdown } from './markdown-normalize';

/**
 * Issue content is untrusted (ADR-b9d4018): raw HTML is never rendered (react-markdown ignores it) and the
 * output is sanitised as well. Links open in a new tab without leaking the opener or referrer. Issue keys that
 * match an issue in this repository link to its page, which opens inside the app (FEAT-130c757).
 */
export function Markdown({ source }: { source: string }) {
  const links = useLinks();
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={links ? [remarkGfm, [remarkIssueKeys, { resolve: links.resolve }]] : [remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ node: _node, href, ...props }) => {
            if (links && href !== undefined && href.startsWith('/repos/')) {
              return <a {...props} href={href} className="issue-key" onClick={internalClick(links, href)} />;
            }
            return <a {...props} href={href} target="_blank" rel="noopener noreferrer nofollow" />;
          },
          input: ({ node: _node, ...props }) => <input {...props} disabled />,
        }}
      >
        {normalizeMarkdown(source)}
      </ReactMarkdown>
    </div>
  );
}
