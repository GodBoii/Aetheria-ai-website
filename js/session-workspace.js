export function getSessionWorkspaceInfo(session = {}) {
    const agentId = String(session.agent_id || '').toLowerCase();

    if (agentId === 'aetheria-coder') {
        return {
            type: 'coder',
            label: 'Coder',
            title: 'Coder Workspace chat',
            iconClass: 'fas fa-code'
        };
    }

    if (agentId === 'aetheria-computer') {
        return {
            type: 'computer',
            label: 'Computer',
            title: 'Computer Workspace chat',
            iconClass: 'fas fa-desktop'
        };
    }

    return {
        type: 'normal',
        label: '',
        title: 'Normal chat',
        iconClass: ''
    };
}

export function shouldShowSessionWorkspaceBadge(session = {}) {
    const workspace = getSessionWorkspaceInfo(session);
    return workspace.type === 'coder' || workspace.type === 'computer';
}
