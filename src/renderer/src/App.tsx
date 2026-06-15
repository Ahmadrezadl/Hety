import { type ReactNode } from 'react'
import { useApp } from './store'
import Gate from './components/Gate'
import Sidebar from './components/Sidebar'
import ProjectGallery from './components/ProjectGallery'
import Workspace from './components/Workspace'
import { Toaster } from './lib/toast'

export default function App(): ReactNode {
  const ready = useApp((s) => s.ready)
  const selectedProjectId = useApp((s) => s.selectedProjectId)

  if (!ready)
    return (
      <>
        <Gate />
        <Toaster />
      </>
    )

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <div className="min-w-0 flex-1">
        {selectedProjectId ? <Workspace key={selectedProjectId} /> : <ProjectGallery />}
      </div>
      <Toaster />
    </div>
  )
}
