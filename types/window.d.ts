declare global {
    // tslint:disable-next-line:interface-name
    interface ElectronBridge {
      ipcRenderer: any;
      TcpSipClient: new (host: string, port: number, secure?: boolean, cert?: string) => {
        connect: () => void;
        disconnect: () => void;
        send: (data: string) => void;
        addEventListener: (event: string, listener: (...args: any[]) => void) => void;
      };
    }
    interface Window {
      jupiterElectron: ElectronBridge;
    }
  }
  
  export default global;