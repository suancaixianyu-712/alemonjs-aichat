import React, { createContext, useContext } from 'react';

// 每次渲染独立提供路径，避免独立服务和 AlemonX 并发访问时互相污染。
const PanelBasePath = createContext("");
const panelUrl = (basePath, url) => url.startsWith("/") && !url.startsWith("//") ? `${basePath}${url}` : url;
const PanelLink = ({ href, ...props }) => {
    const basePath = useContext(PanelBasePath);
    return React.createElement("a", { ...props, href: href ? panelUrl(basePath, href) : href });
};
const PanelForm = ({ action, ...props }) => {
    const basePath = useContext(PanelBasePath);
    return (React.createElement("form", { ...props, action: typeof action === "string" ? panelUrl(basePath, action) : action }));
};
const PanelImage = ({ src, ...props }) => {
    const basePath = useContext(PanelBasePath);
    return (React.createElement("img", { ...props, src: typeof src === "string" ? panelUrl(basePath, src) : src }));
};

export { PanelBasePath, PanelForm, PanelImage, PanelLink, panelUrl };
