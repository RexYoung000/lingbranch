import type { CSSProperties } from 'react';
import { ArrowUpRight, FileText, Image as ImageIcon } from 'lucide-react';
import { attachmentUrl, coverImage, imageCounts, type Idea } from '@/lib/idea-store';

// 两个视图只共享内容呈现；浮层位置、滚动和焦点由各自容器负责。
export default function InspirationCard({idea,onOpen,className='',style,autoFocus=false,showOpenHint=false}:{
  idea:Idea;onOpen:()=>void;className?:string;style?:CSSProperties;autoFocus?:boolean;showOpenHint?:boolean;
}) {
  const cover=coverImage(idea),counts=imageCounts(idea);
  return <button type="button" className={`atlas-card atlas-content-card ${className}`} style={style}
    autoFocus={autoFocus} onClick={onOpen} data-idea-card={idea.id} title={idea.title} aria-label={`打开详情：${idea.title}`}>
    <div className="atlas-card-body">
      {cover&&<img className="atlas-card-image" src={attachmentUrl(cover.id)} alt="" draggable={false} loading="lazy"/>}
      <h2>{idea.title}</h2>
      <p>{idea.summary||idea.sourceLabel||(counts.total?idea.attachments.map(file=>file.name).join('、'):'打开查看内容')}</p>
      {idea.tags.length>0&&<div className="atlas-card-tags">{idea.tags.slice(0,3).map(tag=><span key={tag}>{tag}</span>)}</div>}
    </div>
    <div className="atlas-preview-foot">
      <div className="atlas-card-meta">
        {idea.archived&&<span className="atlas-card-state">已归档</span>}
        {counts.images>0&&<span><ImageIcon size={13}/>{counts.images} 图</span>}
        {counts.files>0&&<span><FileText size={13}/>{counts.files} 文件</span>}
        <time dateTime={idea.updatedAt}>{new Date(idea.updatedAt).toLocaleDateString('zh-CN',{month:'short',day:'numeric'})}</time>
      </div>
      {showOpenHint&&<span className="atlas-preview-open">打开完整详情 <ArrowUpRight size={15}/></span>}
    </div>
  </button>;
}
