import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateTaskDto } from './dto/create-task.dto.js';
import { UpdateTaskDto } from './dto/update-task.dto.js';
import { Task } from './entities/task.entity.js';

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(Task)
    private readonly tasksRepository: Repository<Task>,
  ) {}

  create(createTaskDto: CreateTaskDto) {
    const task = this.tasksRepository.create(createTaskDto);

    return this.tasksRepository.save(task);
  }

  findAll() {
    return this.tasksRepository.find();
  }

  async findOne(id: number) {
    const task = await this.tasksRepository.findOneBy({ id });

    if (!task) {
      throw new NotFoundException(`Task with id ${id} not found`);
    }

    return task;
  }

  async update(id: number, updateTaskDto: UpdateTaskDto) {
    const task = await this.findOne(id);
    const updatedTask = this.tasksRepository.merge(task, updateTaskDto);

    return this.tasksRepository.save(updatedTask);
  }

  async remove(id: number) {
    const task = await this.findOne(id);

    await this.tasksRepository.remove(task);

    return { deleted: true, id };
  }
}
