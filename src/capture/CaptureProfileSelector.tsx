import { Contact, Zap } from 'lucide-react';
import type { CaptureProfile } from './captureProfile';

interface Props {
  value:       CaptureProfile;
  onChange:    (profile: CaptureProfile) => void;
  disabled?:   boolean;
}

const OPTIONS: {
  value:        CaptureProfile;
  label:        string;
  tagline:      string;
  icon:         React.ReactNode;
  activeText:   string;
  activeBg:     string;
  activeBorder: string;
}[] = [
  {
    value:        'CRM',
    label:        'CRM',
    tagline:      'Accuracy first',
    icon:         <Contact className="w-3.5 h-3.5" />,
    activeText:   'text-blue-700',
    activeBg:     'bg-blue-50',
    activeBorder: 'border-blue-200',
  },
  {
    value:        'EXHIBITION',
    label:        'Exhibition',
    tagline:      'Speed first',
    icon:         <Zap className="w-3.5 h-3.5" />,
    activeText:   'text-amber-700',
    activeBg:     'bg-amber-50',
    activeBorder: 'border-amber-200',
  },
];

export function CaptureProfileSelector({ value, onChange, disabled = false }: Props) {
  return (
    <div
      className={`flex items-center gap-1 p-1 bg-stone-100 rounded-xl transition-opacity ${disabled ? 'opacity-40 pointer-events-none' : ''}`}
      role="radiogroup"
      aria-label="Capture profile"
    >
      {OPTIONS.map((opt) => {
        const isActive = value === opt.value;
        return (
          <button
            key={opt.value}
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(opt.value)}
            disabled={disabled}
            className={[
              'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg',
              'text-xs font-semibold transition-all duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-stone-400',
              isActive
                ? `${opt.activeBg} ${opt.activeText} border ${opt.activeBorder} shadow-sm`
                : 'text-stone-500 hover:text-stone-700',
            ].join(' ')}
          >
            {opt.icon}
            <span>{opt.label}</span>
            <span className={`hidden sm:inline font-normal ${isActive ? 'opacity-70' : 'opacity-0'}`}>
              · {opt.tagline}
            </span>
          </button>
        );
      })}
    </div>
  );
}
