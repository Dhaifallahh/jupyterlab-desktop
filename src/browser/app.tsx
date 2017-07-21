// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
    JSONObject
} from '@phosphor/coreutils';

import {
    PageConfig
} from '@jupyterlab/coreutils';

import {
    ElectronJupyterLab
} from './electron-extension';

import {
    StateDB
} from '@jupyterlab/coreutils';

import {
    JupyterServerIPC as ServerIPC,
    JupyterApplicationIPC as AppIPC,
    JupyterWindowIPC as WindowIPC
} from '../ipc';

import {
    SplashScreen, ServerManager
} from './electron-launcher';

import * as React from 'react';
import extensions from './extensions';

/**
 * Use window.require to prevent webpack
 * from trying to resolve the electron library
 */
let ipcRenderer = (window as any).require('electron').ipcRenderer;




export
class Application extends React.Component<Application.Props, Application.State> {
    
    private lab: ElectronJupyterLab;

    private ignorePlugins: string[];

    private server: ServerIPC.Data.ServerDesc = null;

    private nextServerId: number = 1;
    
    private serverState: StateDB;

    constructor(props: Application.Props) {
        super(props);
        this.renderServerManager = this.renderServerManager.bind(this);
        this.renderSplash = this.renderSplash.bind(this);
        this.renderLab = this.renderLab.bind(this);
        this.serverSelected = this.serverSelected.bind(this);
        this.connectionAdded = this.connectionAdded.bind(this);

        let labReady = this.setupLab();

        // Always insert local connection into connections state
        let conns: Application.Connections = {servers: [{
            id: this.nextServerId,
            name: 'Local',
            type: 'local'
        }]};

        if (this.props.options.state == 'local') {
            this.state = {renderState: this.renderSplash, conns: conns}
            ipcRenderer.send(ServerIPC.Channels.REQUEST_SERVER_START, "start");
        } else {
            this.state = {renderState: this.renderServerManager, conns: conns}
        }
        
        this.serverState = new StateDB({namespace: Application.STATE_NAMESPACE});
        this.serverState.fetch(Application.SERVER_STATE_ID)
            .then((data: Application.Connections | null) => {
                if (!data)
                    return;
                // Find max connection ID
                let maxID = 0;
                for (let val of data.servers)
                    maxID = Math.max(maxID, val.id);
                this.nextServerId = maxID + 1;
                // Render UI with saved servers
                this.setState({conns: data});
            })
            .catch((e) => {
                console.log(e);
            });
        
        /* Setup server data response handler */
        ipcRenderer.on(ServerIPC.Channels.SERVER_STARTED, (event: any, data: ServerIPC.Data.ServerDesc) => {
            window.addEventListener('beforeunload', () => {
                ipcRenderer.send(ServerIPC.Channels.REQUEST_SERVER_STOP, data);
            });
            this.server = data;
            PageConfig.setOption("token", data.token);
            PageConfig.setOption("baseUrl", data.url);
            try{
                labReady.then(() => {
                    this.lab.start({ "ignorePlugins": this.ignorePlugins});
                    (this.refs.splash as SplashScreen).fadeSplashScreen();
                });
            }
            catch (e){
                console.log(e);
            }
        });
    }

    private saveState() {
        this.serverState.save(Application.SERVER_STATE_ID, this.state.conns);
    }

    private setupLab(): Promise<void> {
        return new Promise<void>((res, rej) => {
            let version : string = PageConfig.getOption('appVersion') || 'unknown';
            let name : string = PageConfig.getOption('appName') || 'JupyterLab';
            let namespace : string = PageConfig.getOption('appNamespace') || 'jupyterlab';
            let devMode : string  = PageConfig.getOption('devMode') || 'false';
            let settingsDir : string = PageConfig.getOption('settingsDir') || '';
            let assetsDir : string = PageConfig.getOption('assetsDir') || '';

            // Get platform information from main process
            ipcRenderer.send(AppIPC.Channels.GET_PLATFORM);
            let platformSet = new Promise( (resolve, reject) => {
                ipcRenderer.on(AppIPC.Channels.SEND_PLATFORM, (event: any, args: string) => {
                    resolve(args);
                });
            });

            platformSet.then((platform) => {
                if (platform == 'win32')
                    PageConfig.setOption('terminalsAvailable', 'false');
            })

            if (version[0] === 'v') {
                version = version.slice(1);
            }

            this.lab = new ElectronJupyterLab({
                namespace: namespace,
                name: name,
                version: version,
                devMode: devMode.toLowerCase() === 'true',
                settingsDir: settingsDir,
                assetsDir: assetsDir,
                mimeExtensions: extensions.mime
            });

            try {
                this.lab.registerPluginModules(extensions.jupyterlab);
            } catch (e) {
                console.error(e);
            }
            
            // Ignore Plugins
            this.ignorePlugins = [];
            try {
                let option = PageConfig.getOption('ignorePlugins');
                this.ignorePlugins = JSON.parse(option);
            } catch (e) {
                // No-op
            }
            res();
        });
    }

    private connectionAdded(server: ServerIPC.Data.ServerDesc) {
        this.setState((prev: ServerManager.State) => {
            server.id = this.nextServerId++;
            let conns = this.state.conns.servers.concat(server);
            return({
                renderState: this.renderServerManager,
                conns: {servers: conns}
            });
        });
    }

    private serverSelected(server: ServerIPC.Data.ServerDesc) {
        this.saveState();
        if (server.type == 'local') {
            // Request local server start from main process
            ipcRenderer.send(ServerIPC.Channels.REQUEST_SERVER_START, 
                            server as ServerIPC.Data.RequestServerStart);
            // Update window state in main process
            ipcRenderer.send(WindowIPC.Channels.STATE_UPDATE, {state: 'local'});
            // Render the splash screen
            this.setState({renderState: this.renderSplash});
            return;
        }
        
        // Connect JupyterLab to remote server
        PageConfig.setOption('baseUrl', server.url);
        PageConfig.setOption('token', server.token);
        try {
            this.lab.start({ "ignorePlugins": this.ignorePlugins});
        }
        catch (e){
            console.log(e);
        }
        // Update window state in main process
        ipcRenderer.send(WindowIPC.Channels.STATE_UPDATE, {state: 'remote', serverId: server.id});
        // Render JupyterLab
        this.setState({renderState: this.renderLab});
    }

    private renderServerManager(): any {
        return <ServerManager servers={this.state.conns.servers} 
                              serverSelected={this.serverSelected}
                              serverAdded={this.connectionAdded} />;
    }

    private renderSplash() {
        /* Request Jupyter server data from main process, then render
         * splash screen
         */
        return (
            <SplashScreen  ref='splash' finished={() => {
                this.setState({renderState: this.renderLab});}
            } />
        );
    }

    private renderLab(): any {
        return null;
    }

    render() {
        return this.state.renderState();
    }
}

export 
namespace Application {
    
    /**
     * Namspace for server manager state stored in StateDB
     */
    export
    const STATE_NAMESPACE =  'JupyterApplication-state';

    /**
     * ID for ServerManager server data in StateDB
     */
    export
    const SERVER_STATE_ID = 'servers';

    export
    interface Props {
        options: WindowIPC.Data.WindowOptions;
    }

    export
    interface State {
        renderState: () => any;
        conns: Connections;
    }
    
    export
    interface Connections extends JSONObject {
        servers: ServerIPC.Data.ServerDesc[];
    }

}
