import React, { useState, useRef } from 'react';

interface ToolOption {
  id: string;
  label: string;
  icon: React.ElementType;
  shortcut?: string;
}

interface ToolSection {
  section: string;
}

export type ToolMenuEntry = ToolOption | ToolSection;

function isSection(entry: ToolMenuEntry): entry is ToolSection {
  return 'section' in entry;
}

interface ToolMenuProps {
  icon: React.ElementType;
  isActive: boolean;
  options: ToolMenuEntry[];
  onSelect: (id: string) => void;
}

export function ToolMenu({ icon: Icon, isActive, options, onSelect }: ToolMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 150);
  };

  return (
    <div
      className="relative flex items-center justify-center w-full"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${isActive
            ? 'text-primary bg-primary/10'
            : isOpen
              ? 'text-text-primary bg-elevated'
              : 'text-text-secondary hover:bg-elevated hover:text-text-primary'
          }`}
      >
        <Icon size={15} />
      </button>

      {isOpen && (
        <div className="absolute left-[100%] top-0 z-50 ml-1 w-56 max-h-[70vh] overflow-y-auto overscroll-contain rounded-md border border-border-default bg-surface shadow-lg panel-shadow py-1">
          {options.map((entry, idx) => {
            if (isSection(entry)) {
              return (
                <div key={`section-${idx}`} className="px-3 pt-3 pb-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-text-secondary/50">
                    {entry.section}
                  </span>
                </div>
              );
            }

            const OptionIcon = entry.icon;
            return (
              <button
                key={entry.id}
                onClick={() => {
                  onSelect(entry.id);
                  setIsOpen(false);
                }}
                className="flex w-full items-center gap-3 px-3 py-1.5 text-sm text-text-secondary hover:bg-elevated hover:text-text-primary text-left"
              >
                <OptionIcon size={14} className="shrink-0" />
                <span className="flex-1 truncate">{entry.label}</span>
                {entry.shortcut && (
                  <span className="text-[10px] font-mono text-text-secondary/40">{entry.shortcut}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
