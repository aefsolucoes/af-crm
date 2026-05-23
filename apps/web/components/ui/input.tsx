import { cn } from '@/lib/utils';
import { InputHTMLAttributes, forwardRef } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, id, ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1">
        {label && <label htmlFor={id} className="text-sm font-medium text-slate-700">{label}</label>}
        <input
          id={id}
          ref={ref}
          className={cn(
            'w-full px-3 py-2 text-sm border rounded-lg bg-white text-slate-900 placeholder-slate-400',
            'border-af-border focus:outline-none focus:ring-2 focus:ring-af-accent focus:border-transparent',
            error && 'border-red-500',
            className
          )}
          {...props}
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  }
);
Input.displayName = 'Input';
