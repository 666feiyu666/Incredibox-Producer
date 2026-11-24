# Incredibox Producer

给 Steam 版《Incredibox》做一套外接的自动化作曲工作台：在浏览器里用 7×N 网格编曲，通过 Chrome DevTools Protocol 把一段运行时注入游戏，跟着游戏自己的音频循环，把 7 个小人的换装、静音、拍内切分精确踩在小节边界上，并调用游戏原生录制一键出带。开发目标是让「用代码写一段 Incredibox 编曲」像用 DAW 一样自然——不改游戏文件、不装常驻外挂进程，宿主关掉也不影响游戏本身。
