import { useState } from "react";
import type { Attachment } from "@/lib/idea-store";
import { attachmentUrl } from "@/lib/idea-store";

export default function VideoPreview({file}:{file:Attachment}) {
  const [unplayable,setUnplayable]=useState(false);
  if(unplayable)return <p className="atlas-video-unplayable" role="status">视频无法播放，可下载原件。</p>;
  return <video className="atlas-video-player" controls preload="metadata" playsInline aria-label={`播放视频：${file.name}`} onError={()=>setUnplayable(true)}>
    <source src={attachmentUrl(file.id)} type="video/mp4"/>
    当前浏览器不支持 MP4 视频播放，可下载原件。
  </video>;
}
