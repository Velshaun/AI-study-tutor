import {
  AudioLines,
  FileSpreadsheet,
  FileText,
  Globe,
  Image as ImageIcon,
  MonitorPlay,
  Video,
} from 'lucide-react'

import { classifyFile } from '../../lib/uploads'

/**
 * The icon for a source row.
 *
 * Both source lists carried their own copy of this and neither knew about
 * photos or screen recordings, so an uploaded photo of notes showed a generic
 * document icon. One component keeps them honest — and it renders the icon
 * itself rather than handing back a component, which keeps the element stable
 * across renders.
 *
 * `source_type` comes from the server ('pdf' | 'image' | 'video' | 'audio' |
 * 'text' | 'youtube' | 'web'); the filename is the fallback for rows written
 * before their type existed.
 */
export default function SourceIcon({ source, ...props }) {
  const kind =
    source?.source_type && source.source_type !== 'unknown'
      ? source.source_type
      : classifyFile({ name: source?.filename || '' })

  switch (kind) {
    case 'youtube':
      return <Video {...props} />
    case 'web':
      return <Globe {...props} />
    case 'image':
      return <ImageIcon {...props} />
    case 'video':
      return <MonitorPlay {...props} />
    case 'audio':
      return <AudioLines {...props} />
    case 'csv':
      return <FileSpreadsheet {...props} />
    default:
      return <FileText {...props} />
  }
}
