import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Do not log article content, attachments or authentication information.
  }

  render() {
    if (this.state.failed) {
      return (
        <section className="page" role="alert">
          <h2>页面暂时无法显示</h2>
          <p className="muted">可以重试或切换页面。若仍无法恢复，请刷新后重试。</p>
          <button className="button" type="button" onClick={() => this.setState({ failed: false })}>重试</button>
          <button className="button button--quiet" type="button" onClick={() => window.location.reload()}>刷新页面</button>
        </section>
      );
    }
    return this.props.children;
  }
}

export function PageBoundary({ children, resetOnNavigation = true }: { children: ReactNode; resetOnNavigation?: boolean }) {
  const location = useLocation();
  return <Boundary key={resetOnNavigation ? location.pathname : "app"}>{children}</Boundary>;
}

export function PageLoading() {
  return <div className="page" role="status" aria-live="polite">正在加载页面……</div>;
}
