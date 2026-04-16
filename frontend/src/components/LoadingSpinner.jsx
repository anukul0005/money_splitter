export default function LoadingSpinner({ text = 'Loading…' }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <div className="w-8 h-8 border-[3px] border-brand-400/30 border-t-brand-400 rounded-full animate-spin" />
      <p className="text-sm text-green-200/50 font-medium">{text}</p>
    </div>
  )
}
