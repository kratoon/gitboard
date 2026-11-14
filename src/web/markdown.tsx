import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

/**
 * Issue content is untrusted (ADR-0005): raw HTML is never rendered (react-markdown ignores it) and the
 * output is sanitised as well. Links open in a new tab without leaking the opener or referrer.
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
          input: ({ node: _node, ...props }) => <input {...props} disabled />,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
