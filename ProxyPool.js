import axios from 'axios';

/**
 * 代理池类，用于管理和提供HTTP代理
 */
class ProxyPool {
  /**
   * 创建代理池实例
   * @param {Object} options - 配置选项
   * @param {number} options.targetCount - 目标代理数量，默认20
   * @param {number} options.batchSize - 每次获取的代理数量，默认20
   * @param {number} options.testTimeout - 测试代理超时时间(毫秒)，默认5000
   * @param {number} options.requestTimeout - 请求目标网站超时时间(毫秒)，默认10000
   * @param {string} options.targetUrl - 目标网站URL，默认'https://www.notion.so'
   * @param {number} options.concurrentRequests - 并发请求数量，默认10
   * @param {number} options.minThreshold - 可用代理数量低于此阈值时自动补充，默认5
   * @param {number} options.checkInterval - 检查代理池状态的时间间隔(毫秒)，默认30000
   * @param {string} options.proxyProtocol - 代理协议，默认'http'
   * @param {number} options.maxRefillAttempts - 最大补充尝试次数，默认20
   * @param {number} options.retryDelay - 重试延迟(毫秒)，默认1000
   * @param {boolean} options.useCache - 是否使用缓存，默认true
   * @param {number} options.cacheExpiry - 缓存过期时间(毫秒)，默认3600000 (1小时)
   * @param {string} options.logLevel - 日志级别，可选值：'debug', 'info', 'warn', 'error', 'none'，默认'info'
   * @param {boolean} options.showProgressBar - 是否显示进度条，默认false
   */
  constructor(options = {}) {
    // 配置参数
    this.targetCount = options.targetCount || 20;
    this.batchSize = options.batchSize || 20;
    this.testTimeout = options.testTimeout || 5000;
    this.requestTimeout = options.requestTimeout || 10000;
    this.targetUrl = options.targetUrl || 'https://www.notion.so';
    this.concurrentRequests = options.concurrentRequests || 10;
    this.minThreshold = options.minThreshold || 5;
    this.checkInterval = options.checkInterval || 30000; // 默认30秒检查一次
    this.proxyProtocol = options.proxyProtocol || 'http';
    this.maxRefillAttempts = options.maxRefillAttempts || 20; // 减少最大尝试次数
    this.retryDelay = options.retryDelay || 1000; // 减少重试延迟
    this.useCache = options.useCache !== undefined ? options.useCache : true;
    this.cacheExpiry = options.cacheExpiry || 3600000; // 默认1小时
    this.logLevel = options.logLevel || 'info'; // 默认日志级别为info
    this.showProgressBar = options.showProgressBar !== undefined ? options.showProgressBar : false; // 是否显示进度条
    
    // 内部状态
    this.availableProxies = [];
    this.currentIndex = 0;
    this.isInitialized = false;
    this.isRefilling = false;
    this.checkTimer = null;
    this.proxyCache = new Map(); // 缓存验证过的代理
    this.proxyCountry = 'us';
    
    // 进度条状态
    this.progressTotal = 0;
    this.progressCurrent = 0;
    this.progressBarLength = 30; // 进度条长度
    this.lastProgressString = ''; // 上次显示的进度字符串
    
    // 日志级别权重
    this.logLevels = {
      'debug': 0,
      'info': 1,
      'warn': 2,
      'error': 3,
      'none': 4
    };
    
    // 绑定方法
    this.getProxy = this.getProxy.bind(this);
    this.removeProxy = this.removeProxy.bind(this);
    this.checkAndRefill = this.checkAndRefill.bind(this);
  }

  /**
   * 设置代理国家
   * @param {string} country - 代理国家 支持us uk jp de fr ca
   */
  setCountry(country) {
    this.proxyCountry = country;
  }
  
  /**
   * 根据设置的日志级别输出日志
   * @param {string} level - 日志级别
   * @param {...any} args - 日志参数
   */
  log(level, ...args) {
    if (this.logLevels[level] >= this.logLevels[this.logLevel]) {
      if (level === 'error') {
        console.error(...args);
      } else if (level === 'warn') {
        console.warn(...args);
      } else if (level === 'info' || level === 'debug') {
        console.log(...args);
      }
    }
  }
  
  /**
   * 显示进度条
   * @param {string} message - 进度条前的消息
   * @param {number} current - 当前进度
   * @param {number} total - 总进度
   * @param {boolean} [complete=false] - 是否完成
   */
  showProgress(message, current, total) {
    if (!this.showProgressBar) return;
    
    // 确保进度不超过总数
    current = Math.min(current, total);
    
    // 计算进度百分比
    const percent = total > 0 ? Math.floor((current / total) * 100) : 0;
    
    // 创建终端风格的箭头进度条
    let bar = '';
    let ProcessBarLength = 15;
    let CurrentProcessBarLength = Math.floor(ProcessBarLength*(percent/100));
    let ProcessBarRemainLength = ProcessBarLength-CurrentProcessBarLength;
    let ProcessBar = '-'.repeat(CurrentProcessBarLength)+'>';
    let ProcessBarRemain = '·'.repeat(ProcessBarRemainLength);
    if (percent === 100) {
      // 完成状态显示完整箭头
      bar = '['+'-'.repeat(ProcessBarLength)+'>'+']';
    } else {
      bar = '['+ProcessBar+ProcessBarRemain+']';
    }
    
    // 构建进度字符串，添加百分比
    const progressString = `${message} ${bar} ${current}/${total} (${percent}%)`;
    
    // 如果进度字符串与上次相同，则不重复显示
    if (progressString === this.lastProgressString) {
      return;
    }
    
    // 清除上一行
    if (this.lastProgressString) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    }
    
    // 显示进度条
    process.stdout.write(progressString);
    
    // 如果完成，换行
    if (percent === 100) {
      process.stdout.write('\n');
    }
    
    // 保存当前进度字符串
    this.lastProgressString = progressString;
  }
  
  /**
   * 初始化代理池
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.isInitialized) return;
    
    this.log('info', `初始化代理池，目标数量: ${this.targetCount}`);
    
    // 重置进度条状态
    this.progressTotal = this.targetCount;
    this.progressCurrent = 0;
    //this.showProgress('初始化代理池进度', this.progressCurrent, this.progressTotal);
    
    await this.refillProxies();
    
    // 设置定时检查
    this.checkTimer = setInterval(this.checkAndRefill, this.checkInterval);
    
    this.isInitialized = true;
    
    // 完成进度条
    this.showProgress('补充代理进度', this.availableProxies.length, this.progressTotal);
    this.log('info', `代理池初始化完成，当前可用代理数量: ${this.availableProxies.length}`);
  }
  
  /**
   * 停止代理池服务
   */
  stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.log('info', '代理池服务已停止');
  }
  
  /**
   * 检查并补充代理
   */
  async checkAndRefill() {
    if (this.availableProxies.length <= this.minThreshold && !this.isRefilling) {
      this.log('info', `可用代理数量(${this.availableProxies.length})低于阈值(${this.minThreshold})，开始补充代理`);
      await this.refillProxies();
    }
  }
  
  /**
   * 补充代理到目标数量
   * @returns {Promise<void>}
   */
  async refillProxies() {
    if (this.isRefilling) return;
    
    this.isRefilling = true;
    this.log('info', `开始补充代理，当前数量: ${this.availableProxies.length}，目标数量: ${this.targetCount}`);
    
    // 设置进度条状态
    this.progressTotal = this.targetCount;
    this.progressCurrent = this.availableProxies.length;
    this.showProgress('补充代理进度', this.progressCurrent, this.progressTotal);
    
    let attempts = 0;
    
    try {
      // 计算需要补充的代理数量
      const neededProxies = this.targetCount - this.availableProxies.length;
      
      // 优先检查缓存中的代理
      if (this.useCache && this.proxyCache.size > 0) {
        await this.tryUsingCachedProxies(neededProxies);
        
        // 更新进度条
        this.progressCurrent = this.availableProxies.length;
        this.showProgress('补充代理进度', this.progressCurrent, this.progressTotal);
      }
      
      // 如果缓存中的代理不足，继续获取新代理
      while (this.availableProxies.length < this.targetCount && attempts < this.maxRefillAttempts) {
        attempts++;
        
        this.log('debug', `补充尝试 #${attempts}，当前可用代理: ${this.availableProxies.length}/${this.targetCount}`);
        
        // 计算本次需要获取的批次大小
        const remainingNeeded = this.targetCount - this.availableProxies.length;
        const batchSizeNeeded = Math.max(this.batchSize, remainingNeeded * 2); // 获取更多代理以提高成功率
        
        // 获取代理
        const proxies = await this.getProxiesFromProvider(batchSizeNeeded);
        
        if (proxies.length === 0) {
          this.log('debug', `没有获取到代理，等待${this.retryDelay/1000}秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
          continue;
        }
        
        // 过滤掉已有的代理
        const newProxies = this.filterExistingProxies(proxies);
        
        if (newProxies.length === 0) {
          this.log('debug', '所有获取的代理都已存在，继续获取新代理...');
          continue;
        }
        
        // 保存当前进度，测试代理过程中会临时更新进度条
        const previousProgress = this.progressCurrent;
        
        // 测试代理
        const results = await this.testProxiesConcurrently(newProxies);
        
        // 添加可用代理
        this.addValidProxies(results);
        
        // 更新实际进度
        this.progressCurrent = this.availableProxies.length;
        this.showProgress('补充代理进度', this.progressCurrent, this.progressTotal);
        
        // 如果已经获取到足够的代理，提前结束
        if (this.availableProxies.length >= this.targetCount) {
          break;
        }
        
        // 如果还没补充到足够的代理，等待一段时间再继续
        if (this.availableProxies.length < this.targetCount) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        }
      }
    } catch (error) {
      this.log('error', '补充代理过程中出错:', error);
    } finally {
      this.isRefilling = false;      
      if (this.availableProxies.length >= this.targetCount) {
        this.log('info', `代理补充完成，当前可用代理: ${this.availableProxies.length}/${this.targetCount}`);
      } else {
        this.log('info', `已达到最大尝试次数 ${this.maxRefillAttempts}，当前可用代理: ${this.availableProxies.length}/${this.targetCount}`);
      }
    }
  }
  
  /**
   * 尝试使用缓存中的代理
   * @param {number} neededProxies - 需要的代理数量
   */
  async tryUsingCachedProxies(neededProxies) {
    const now = Date.now();
    const cachedProxies = [];
    
    // 筛选未过期的缓存代理
    for (const [proxyKey, data] of this.proxyCache.entries()) {
      if (now - data.timestamp < this.cacheExpiry && data.valid) {
        cachedProxies.push(proxyKey);
        
        if (cachedProxies.length >= neededProxies) {
          break;
        }
      }
    }
    
    if (cachedProxies.length > 0) {
      this.log('debug', `从缓存中找到 ${cachedProxies.length} 个可能可用的代理`);
      
      // 验证缓存的代理是否仍然可用
      const results = await this.testProxiesConcurrently(cachedProxies);
      this.addValidProxies(results);
    }
  }
  
  /**
   * 过滤掉已存在的代理
   * @param {Array<string>} proxies - 代理列表
   * @returns {Array<string>} - 新代理列表
   */
  filterExistingProxies(proxies) {
    return proxies.filter(proxy => {
      const proxyParts = proxy.split(':');
      const ip = proxyParts[0];
      const port = proxyParts[1];
      
      // 如果有用户名和密码，也需要比较这些信息
      if (proxyParts.length >= 4) {
        const username = proxyParts[2];
        const password = proxyParts[3];
        return !this.availableProxies.some(p => 
          p.ip === ip && 
          p.port === port && 
          p.username === username && 
          p.password === password
        );
      }
      
      // 没有用户名和密码时，只比较IP和端口
      return !this.availableProxies.some(p => p.ip === ip && p.port === port);
    });
  }
  
  /**
   * 添加有效的代理到代理池
   * @param {Array<{proxy: string, result: boolean}>} results - 测试结果
   */
  addValidProxies(results) {
    for (const { proxy, result } of results) {
      if (result) {
        const proxyParts = proxy.split(':');
        const ip = proxyParts[0];
        const port = proxyParts[1];
        
        // 检查是否已存在
        let exists = false;
        
        if (proxyParts.length >= 4) {
          // 有用户名和密码时，同时比较IP、端口、用户名和密码
          const username = proxyParts[2];
          const password = proxyParts[3];
          exists = this.availableProxies.some(p => 
            p.ip === ip && 
            p.port === port && 
            p.username === username && 
            p.password === password
          );
        } else {
          // 没有用户名和密码时，只比较IP和端口
          exists = this.availableProxies.some(p => p.ip === ip && p.port === port);
        }
        
        if (!exists) {
          const proxyObj = {
            ip,
            port,
            protocol: this.proxyProtocol,
            full: `${this.proxyProtocol}://${proxy}`,
            addedAt: new Date().toISOString()
          };
          
          // 如果有用户名和密码，添加到代理对象
          if (proxyParts.length >= 4) {
            proxyObj.username = proxyParts[2];
            proxyObj.password = proxyParts[3];
            proxyObj.full = `${this.proxyProtocol}://${proxyObj.username}:${proxyObj.password}@${ip}:${port}`;
          }
          
          this.availableProxies.push(proxyObj);
          
          // 添加到缓存
          if (this.useCache) {
            this.proxyCache.set(proxy, { 
              valid: true, 
              timestamp: Date.now() 
            });
          }
          
          this.log('debug', `成功添加代理: ${proxyObj.full}，当前可用代理: ${this.availableProxies.length}/${this.targetCount}`);
          
          if (this.availableProxies.length >= this.targetCount) {
            break;
          }
        }
      } else if (this.useCache) {
        // 记录无效代理到缓存
        this.proxyCache.set(proxy, { 
          valid: false, 
          timestamp: Date.now() 
        });
      }
    }
  }
  
  /**
   * 从代理服务获取代理URL
   * @param {number} count - 请求的代理数量
   * @returns {Promise<Array<string>>} - 代理URL列表
   */
  async getProxiesFromProvider(count = null) {
    try {
      const requestCount = count || this.batchSize;
      // 限制请求数量最大为10
      const actualCount = Math.min(requestCount, 10);
      const url = `https://proxy.doudouzi.me/random/${this.proxyCountry}?number=${actualCount}&protocol=${this.proxyProtocol}&type=json`;
      this.log('debug', `正在获取代理，URL: ${url}`);
      
      const response = await axios.get(url, { 
        timeout: 10000,
        validateStatus: status => true
      });
      
      if (response.data) {
        // 解析返回的数据格式
        const proxyDataArray = response.data.trim().split('\n').filter(line => line.trim() !== '');
        const proxies = [];
        
        for (const line of proxyDataArray) {
          try {
            const proxyData = JSON.parse(line);
            if (proxyData.ip && proxyData.port) {
              // 如果有用户名和密码，则使用认证格式
              if (proxyData.username && proxyData.password) {
                proxies.push(`${proxyData.ip}:${proxyData.port}:${proxyData.username}:${proxyData.password}`);
              } else {
                proxies.push(`${proxyData.ip}:${proxyData.port}`);
              }
            }
          } catch (err) {
            this.log('error', '解析代理数据出错:', err.message);
          }
        }
        
        this.log('debug', `成功获取 ${proxies.length} 个代理`);
        return proxies;
      } else {
        this.log('error', '获取代理失败: 返回数据格式不正确');
        return [];
      }
    } catch (error) {
      this.log('error', '获取代理出错:', error.message);
      return [];
    }
  }
  
  /**
   * 并发测试多个代理
   * @param {Array<string>} proxies - 代理列表
   * @returns {Promise<Array<{proxy: string, result: boolean}>>} - 测试结果
   */
  async testProxiesConcurrently(proxies) {
    const results = [];
    const remainingNeeded = this.targetCount - this.availableProxies.length;
    
    // 增加并发数以加快处理速度
    const concurrentRequests = Math.min(this.concurrentRequests * 2, 20);
    
    // 分批处理代理
    for (let i = 0; i < proxies.length; i += concurrentRequests) {
      const batch = proxies.slice(i, i + concurrentRequests);
      
      // 不再显示测试代理的单独进度条，而是更新补充代理的总体进度
      if (this.showProgressBar) {
        // 计算当前测试进度对应的总体进度
        const testedPercent = i / proxies.length;
        const progressStep = Math.min(1, testedPercent) * 0.2; // 测试部分占总体进度的20%
        const currentProgress = this.progressCurrent + progressStep * (this.targetCount - this.progressCurrent);
        this.showProgress('补充代理进度', Math.floor(currentProgress), this.progressTotal);
      }
      
      const promises = batch.map(proxy => {
        // 检查缓存中是否有近期验证过的结果
        if (this.useCache && this.proxyCache.has(proxy)) {
          const cachedResult = this.proxyCache.get(proxy);
          const isFresh = (Date.now() - cachedResult.timestamp) < this.cacheExpiry;
          
          if (isFresh) {
            // 使用缓存结果，避免重复测试
            return Promise.resolve({ proxy, result: cachedResult.valid });
          }
        }
        
        return this.testProxy(proxy)
          .then(result => ({ proxy, result }))
          .catch(() => ({ proxy, result: false }));
      });
      
      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
      
      // 如果已经找到足够的代理，提前结束测试
      const successCount = results.filter(item => item.result).length;
      if (successCount >= remainingNeeded) {
        break;
      }
    }
    
    // 不再显示测试完成的进度条
    
    return results;
  }
  
  /**
   * 测试代理是否可用
   * @param {string} proxyUrl - 代理URL
   * @returns {Promise<boolean>} - 代理是否可用
   */
  async testProxy(proxyUrl) {
    try {
      // 创建代理配置
      const proxyParts = proxyUrl.split(':');
      const proxyConfig = {
        host: proxyParts[0],
        port: parseInt(proxyParts[1]),
        protocol: this.proxyProtocol
      };
      
      // 如果有用户名和密码，添加认证信息
      if (proxyParts.length >= 4) {
        proxyConfig.auth = {
          username: proxyParts[2],
          password: proxyParts[3]
        };
      }
      
      // 发送请求到目标网站
      const response = await axios.get(this.targetUrl, {
        proxy: proxyConfig,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: this.requestTimeout,
        validateStatus: status => true,
        maxRedirects: 10,
        followRedirect: true
      });
      
      // 检查响应是否包含目标网站特有的内容
      const isTargetContent = response.data && 
                             (typeof response.data === 'string') && 
                             (response.data.includes('notion') || 
                              response.data.includes('Notion'));
      
      const isValid = response.status === 200 && isTargetContent;
      
      if (isValid) {
        this.log('debug', `代理 ${proxyUrl} 请求目标网站成功，状态码: ${response.status}`);
      } else {
        this.log('debug', `代理 ${proxyUrl} 请求目标网站失败，状态码: ${response.status}`);
      }
      
      return isValid;
    } catch (error) {
      this.log('debug', `代理 ${proxyUrl} 请求出错: ${error.message}`);
      return false;
    }
  }
  
  /**
   * 获取一个可用代理
   * @returns {Object|null} - 代理对象，如果没有可用代理则返回null
   */
  getProxy() {
    if (this.availableProxies.length === 0) {
      this.log('warn', '没有可用代理');
      return null;
    }
    
    // 轮询方式获取代理
    const proxy = this.availableProxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.availableProxies.length;
    
    return proxy;
  }
  
  /**
   * 移除指定代理
   * @param {string} ip - 代理IP
   * @param {string|number} port - 代理端口
   * @returns {boolean} - 是否成功移除
   */
  removeProxy(ip, port) {
    const portStr = port.toString();
    const initialLength = this.availableProxies.length;
    
    // 找到要移除的代理
    const proxyToRemove = this.availableProxies.find(
      proxy => proxy.ip === ip && proxy.port === portStr
    );
    
    if (proxyToRemove) {
      // 更新缓存，标记为无效
      if (this.useCache) {
        const proxyKey = `${ip}:${portStr}`;
        this.proxyCache.set(proxyKey, { valid: false, timestamp: Date.now() });
      }
    }
    
    this.availableProxies = this.availableProxies.filter(
      proxy => !(proxy.ip === ip && proxy.port === portStr)
    );
    
    // 重置当前索引，确保不会越界
    if (this.currentIndex >= this.availableProxies.length && this.availableProxies.length > 0) {
      this.currentIndex = 0;
    }
    
    const removed = initialLength > this.availableProxies.length;
    
    if (removed) {
      this.log('debug', `已移除代理 ${ip}:${port}，当前可用代理: ${this.availableProxies.length}`);
    } else {
      this.log('debug', `未找到要移除的代理 ${ip}:${port}`);
    }
    
    // 如果移除后代理数量低于阈值，触发补充
    this.checkAndRefill();
    
    return removed;
  }
  
  /**
   * 获取所有可用代理
   * @returns {Array<Object>} - 代理对象数组
   */
  getAllProxies() {
    return [...this.availableProxies];
  }
  
  /**
   * 获取可用代理数量
   * @returns {number} - 代理数量
   */
  getCount() {
    return this.availableProxies.length;
  }
  
  /**
   * 清理过期的缓存条目
   */
  cleanupCache() {
    if (!this.useCache) return;
    
    const now = Date.now();
    let cleanupCount = 0;
    
    for (const [key, data] of this.proxyCache.entries()) {
      if (now - data.timestamp > this.cacheExpiry) {
        this.proxyCache.delete(key);
        cleanupCount++;
      }
    }
    
    if (cleanupCount > 0) {
      this.log('debug', `清理了 ${cleanupCount} 个过期的缓存代理`);
    }
  }
}

// 使用示例
async function example() {
  // 创建代理池实例
  const proxyPool = new ProxyPool({
    targetCount: 10,           // 目标保持10个代理
    minThreshold: 3,           // 当可用代理少于3个时，自动补充
    checkInterval: 60000,      // 每60秒检查一次
    targetUrl: 'https://www.notion.so',
    concurrentRequests: 15,    // 增加并发请求数
    useCache: true,            // 启用缓存
    maxRefillAttempts: 15,     // 减少最大尝试次数
    retryDelay: 1000,          // 减少重试延迟
    logLevel: 'info',          // 设置日志级别
    showProgressBar: true      // 启用进度条
  });
  
  // 初始化代理池
  await proxyPool.initialize();
  
  // 获取一个代理
  const proxy = proxyPool.getProxy();
  console.log('获取到代理:', proxy);
  
  // 模拟使用一段时间后，移除一个代理
  setTimeout(() => {
    if (proxy) {
      proxyPool.removeProxy(proxy.ip, proxy.port);
    }
    
    // 获取所有代理
    const allProxies = proxyPool.getAllProxies();
    console.log(`当前所有代理(${allProxies.length}):`, allProxies);
    
    // 使用完毕后停止服务
    setTimeout(() => {
      proxyPool.stop();
      console.log('代理池示例运行完毕');
    }, 5000);
  }, 5000);
}

// 如果直接运行此文件，则执行示例
if (typeof require !== 'undefined' && require.main === module) {
  example().catch(err => console.error('示例运行出错:', err));
}

// 导出 ProxyPool 类和实例
export default ProxyPool;
export const proxyPool = new ProxyPool({
  logLevel: 'info', // 默认导出的实例使用info级别的日志
  showProgressBar: true // 启用进度条
});

