import type { MobileToolCatalog, MobileToolGroup, MobileToolName } from '@shared/types';

const GROUPS: { key: MobileToolGroup; label: string }[] = [
  { key: 'management', label: '管理 / 观察' },
  { key: 'interface', label: '界面操控' },
  { key: 'privacy', label: '隐私数据' },
  { key: 'communication', label: '通信 / 系统' },
  { key: 'media', label: '媒体' }
];

export function MobileToolPolicy({
  catalog,
  selected,
  onChange,
  disabled = false
}: {
  catalog: MobileToolCatalog | null;
  selected: MobileToolName[];
  onChange: (tools: MobileToolName[]) => void;
  disabled?: boolean;
}) {
  if (!catalog) return <div className="mobile-policy-loading">正在读取 Android 工具目录...</div>;
  const selectedSet = new Set(selected);

  const toggleTool = (name: MobileToolName) => {
    const next = new Set(selectedSet);
    if (next.has(name)) next.delete(name); else next.add(name);
    onChange(catalog.tools.map((tool) => tool.name).filter((name) => next.has(name)));
  };

  const toggleGroup = (group: MobileToolGroup) => {
    const names = catalog.tools.filter((tool) => tool.group === group).map((tool) => tool.name);
    const next = new Set(selectedSet);
    const allOn = names.every((name) => next.has(name));
    for (const name of names) allOn ? next.delete(name) : next.add(name);
    onChange(catalog.tools.map((tool) => tool.name).filter((name) => next.has(name)));
  };

  return (
    <div className="mobile-policy">
      <div className="mobile-policy-head">
        <span>{selected.length} / {catalog.tools.length} 个工具已启用</span>
        <div>
          <button type="button" className="btn btn-xs" disabled={disabled} onClick={() => onChange(catalog.tools.map((tool) => tool.name))}>全选</button>
          <button type="button" className="btn btn-xs" disabled={disabled} onClick={() => onChange([])}>清空</button>
        </div>
      </div>
      <div className="mobile-policy-groups">
        {GROUPS.map((group) => {
          const tools = catalog.tools.filter((tool) => tool.group === group.key);
          const selectedCount = tools.filter((tool) => selectedSet.has(tool.name)).length;
          return (
            <section key={group.key} className="mobile-policy-group">
              <button type="button" className="mobile-policy-group-head" disabled={disabled} onClick={() => toggleGroup(group.key)}>
                <span>{group.label}</span>
                <span>{selectedCount} / {tools.length}</span>
              </button>
              <div className="mobile-policy-tools">
                {tools.map((tool) => (
                  <label key={tool.name} className={selectedSet.has(tool.name) ? 'on' : ''} title={tool.description}>
                    <input type="checkbox" disabled={disabled} checked={selectedSet.has(tool.name)} onChange={() => toggleTool(tool.name)} />
                    <span className="mobile-tool-name">{tool.name.replace(/^android_/, '')}</span>
                    {tool.permissions.length > 0 && <span className="mobile-tool-permission">{tool.permissions.join(', ')}</span>}
                  </label>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
